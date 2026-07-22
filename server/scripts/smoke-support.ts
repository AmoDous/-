import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { postgresPoolConfig } from "../src/storage.js";

const apiBaseUrl = String(process.env.API_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/u, "");
const pool = new Pool({ ...postgresPoolConfig(), max: 1, application_name: "rooms-support-smoke" });
const clientId = randomUUID();
const partnerId = randomUUID();
const venueId = randomUUID();
const roomId = randomUUID();
const bookingId = randomUUID();
const paymentId = randomUUID();
const suffix = clientId.slice(0, 8);
const clientEmail = `smoke.support.client.${suffix}@rooms.test`;
const partnerEmail = `smoke.support.partner.${suffix}@rooms.test`;
const password = "rooms2026";
const adminPassword = process.env.DEMO_ADMIN_PASSWORD?.trim() || password;
let supportId = "";

async function api<T>(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

try {
  const seeded = await pool.query<{ password_hash: string | null }>("select password_hash from users where email = 'manager@kids-loft.ru' limit 1");
  const passwordHash = seeded.rows[0]?.password_hash;
  if (!passwordHash) throw new Error("Seeded partner account is required for the support smoke test.");
  await pool.query(`insert into users (id, role, name, email, phone, city, password_hash, password_reset_required)
    values
      ($1::uuid,'client','Smoke Support Client',$2,$3,'Voronezh',$4,false),
      ($5::uuid,'partner','Smoke Support Partner',$6,null,'Voronezh',$4,false)`, [
    clientId,
    clientEmail,
    `+7901${suffix.replace(/[^0-9]/gu, "").padEnd(7, "0").slice(0, 7)}`,
    passwordHash,
    partnerId,
    partnerEmail,
  ]);
  await pool.query(`insert into venues (
      id, slug, title, city, address, publication_status, verification_status, cabinet_status, partner_mode
    ) values ($1::uuid,$2,'Smoke Support Venue','Voronezh','Support test address','published','verified','active','catalog')`,
  [venueId, `smoke-support-venue-${suffix}`]);
  await pool.query("insert into venue_members (venue_id, user_id, member_role) values ($1::uuid,$2::uuid,'manager')", [venueId, partnerId]);
  await pool.query(`insert into rooms (
      id, venue_id, slug, title, room_type, subtitle, description, rules,
      capacity_max, price_per_hour, minimum_hours, opens_at, closes_at, closes_next_day, status
    ) values ($1::uuid,$2::uuid,$3,'Smoke Support Room','lounge','Support room',
      'Room for support lifecycle verification.','Temporary smoke-test record.',10,1800,2,'10:00','00:00',true,'published')`,
  [roomId, venueId, `smoke-support-room-${suffix}`]);
  await pool.query(`insert into bookings (
      id, public_number, client_id, venue_id, status, client_name, client_phone, client_email, city,
      event_type, guests, starts_at, ends_at, room_total, service_total, total, prepayment,
      commission, partner_amount, remaining_on_site, on_site_payment_method, created_at, updated_at
    ) values ($1::uuid,$2,$3::uuid,$4::uuid,'paid','Smoke Support Client','+79010000000',$5,'Voronezh',
      'smoke',4,now()+interval '7 days',now()+interval '7 days 2 hours',3600,0,3600,1080,540,540,2520,'card',now(),now())`,
  [bookingId, `R-SUPPORT-${suffix.toUpperCase()}`, clientId, venueId, clientEmail]);
  await pool.query(`insert into booking_rooms (
      booking_id, room_id, title_snapshot, price_per_hour_snapshot, amount, is_primary
    ) values ($1::uuid,$2::uuid,'Smoke Support Room',1800,3600,true)`, [bookingId, roomId]);
  await pool.query(`insert into room_reservations (
      room_id, booking_id, source_type, source_id, period, active, details, created_by
    ) values ($1::uuid,$2::uuid,'booking',$2::uuid,tstzrange(now()+interval '7 days',now()+interval '7 days 2 hours','[)'),true,'{}',$3::uuid)`,
  [roomId, bookingId, partnerId]);
  await pool.query(`insert into payment_transactions (
      id, booking_id, provider, provider_payment_id, idempotency_key, status, amount, currency, paid_at
    ) values ($1::uuid,$2::uuid,'rooms_demo',$3,$4,'paid',1080,'RUB',now())`,
  [paymentId, bookingId, `SMOKE-SUPPORT-${suffix}`, `smoke-support-${bookingId}`]);

  const clientLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: clientEmail, password } });
  const partnerLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: partnerEmail, password } });
  const adminLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: "admin@rooms.ru", password: adminPassword } });

  const adminBookings = await api<Array<{ id: string; paymentStatus: string }>>("/v1/admin/bookings?statusGroup=all", { token: adminLogin.accessToken });
  assert.equal(adminBookings.find((booking) => booking.id === bookingId)?.paymentStatus, "paid");
  const opened = await api<{ id: string; status: string }>(`/v1/bookings/${bookingId}/support`, {
    method: "POST",
    token: clientLogin.accessToken,
    body: { topic: "Smoke support", body: "Please check this paid booking before cancellation." },
  });
  supportId = opened.id;
  assert.equal(opened.status, "open");
  const partnerQueue = await api<Array<{ id: string }>>("/v1/partner/support?status=all", { token: partnerLogin.accessToken });
  assert.ok(partnerQueue.some((record) => record.id === supportId));
  await api(`/v1/support/${supportId}/messages`, {
    method: "POST",
    token: partnerLogin.accessToken,
    body: { body: "The partner confirms that Rooms should review the case." },
  });
  const closed = await api<{ status: string }>(`/v1/admin/support/${supportId}`, {
    method: "PATCH",
    token: adminLogin.accessToken,
    body: { status: "closed" },
  });
  assert.equal(closed.status, "closed");
  const cancelled = await api<{ status: string; paymentStatus: string }>(`/v1/admin/bookings/${bookingId}/cancel`, {
    method: "POST",
    token: adminLogin.accessToken,
    body: { reason: "Smoke-test cancellation after payment" },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.paymentStatus, "refund_pending");
  const databaseState = await pool.query<{ active: number; refunds: number; audits: number }>(`
    select
      (select count(*)::integer from room_reservations where booking_id = $1::uuid and active) as active,
      (select count(*)::integer from refunds where payment_id = $2::uuid and status = 'refund_pending') as refunds,
      (select count(*)::integer from audit_log
        where (entity_type = 'booking' and entity_id = $1::text and action = 'booking_cancelled')
          or (entity_type = 'support_case' and entity_id = $3::text and action = 'support_status_changed')) as audits
  `, [bookingId, paymentId, supportId]);
  assert.deepEqual(databaseState.rows[0], { active: 0, refunds: 1, audits: 2 });
  console.log(`Support and admin queue smoke passed for booking ${bookingId}.`);
} finally {
  await pool.query("delete from notification_deliveries where dedupe_key like $1", [`%${bookingId}%`]).catch(() => undefined);
  await pool.query("delete from audit_log where entity_id = any($1::text[])", [[bookingId, supportId].filter(Boolean)]).catch(() => undefined);
  await pool.query("delete from refunds where payment_id = $1::uuid", [paymentId]).catch(() => undefined);
  await pool.query("delete from payment_transactions where id = $1::uuid", [paymentId]).catch(() => undefined);
  await pool.query("delete from bookings where id = $1::uuid", [bookingId]).catch(() => undefined);
  await pool.query("delete from venues where id = $1::uuid", [venueId]).catch(() => undefined);
  await pool.query("delete from users where id = any($1::uuid[])", [[clientId, partnerId]]).catch(() => undefined);
  const cleanup = await pool.query<{ users: number; venues: number; bookings: number; support: number }>(`
    select
      (select count(*)::integer from users where id = any($1::uuid[])) as users,
      (select count(*)::integer from venues where id = $2::uuid) as venues,
      (select count(*)::integer from bookings where id = $3::uuid) as bookings,
      (select count(*)::integer from booking_support_cases where id = $4::uuid) as support
  `, [[clientId, partnerId], venueId, bookingId, supportId || "00000000-0000-0000-0000-000000000000"]);
  assert.deepEqual(cleanup.rows[0], { users: 0, venues: 0, bookings: 0, support: 0 });
  console.log("Support and admin queue smoke cleanup passed.");
  await pool.end();
}
