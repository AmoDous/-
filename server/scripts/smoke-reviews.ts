import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { postgresPoolConfig } from "../src/storage.js";

const apiBaseUrl = String(process.env.API_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/u, "");
const pool = new Pool({ ...postgresPoolConfig(), max: 1, application_name: "rooms-reviews-smoke" });
const clientId = randomUUID();
const partnerId = randomUUID();
const venueId = randomUUID();
const roomId = randomUUID();
const bookingId = randomUUID();
const suffix = clientId.slice(0, 8);
const clientEmail = `smoke.review.client.${suffix}@rooms.test`;
const partnerEmail = `smoke.review.partner.${suffix}@rooms.test`;
const password = "rooms2026";
const adminPassword = process.env.DEMO_ADMIN_PASSWORD?.trim() || password;
let reviewId = "";

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
  if (!passwordHash) throw new Error("Seeded partner account is required for the review smoke test.");
  await pool.query(`insert into users (id, role, name, email, phone, city, password_hash, password_reset_required)
    values
      ($1::uuid,'client','Smoke Review Client',$2,$3,'Воронеж',$4,false),
      ($5::uuid,'partner','Smoke Review Partner',$6,null,'Воронеж',$4,false)`, [
    clientId,
    clientEmail,
    `+7900${suffix.replace(/[^0-9]/gu, "").padEnd(7, "0").slice(0, 7)}`,
    passwordHash,
    partnerId,
    partnerEmail,
  ]);
  await pool.query(`insert into venues (
      id, slug, title, city, address, publication_status, verification_status, cabinet_status, partner_mode
    ) values ($1::uuid,$2,'Smoke Review Venue','Воронеж','Тестовый адрес отзывов, 1','published','verified','active','catalog')`,
  [venueId, `smoke-review-venue-${suffix}`]);
  await pool.query("insert into venue_members (venue_id, user_id, member_role) values ($1::uuid,$2::uuid,'manager')", [venueId, partnerId]);
  await pool.query(`insert into rooms (
      id, venue_id, slug, title, room_type, subtitle, description, rules,
      capacity_max, price_per_hour, minimum_hours, rating_cached, review_count_cached,
      opens_at, closes_at, closes_next_day, status
    ) values ($1::uuid,$2::uuid,$3,'Smoke Review Room','lounge','Тестовое помещение',
      'Помещение для проверки отзывов.','Запись будет удалена после проверки.',10,1800,2,0,0,'10:00','00:00',true,'published')`,
  [roomId, venueId, `smoke-review-room-${suffix}`]);
  await pool.query(`insert into bookings (
      id, public_number, client_id, venue_id, status, client_name, client_phone, client_email, city,
      event_type, guests, starts_at, ends_at, room_total, service_total, total, prepayment,
      commission, partner_amount, remaining_on_site, on_site_payment_method, created_at, updated_at
    ) values ($1::uuid,$2,$3::uuid,$4::uuid,'paid','Smoke Review Client','+79000000000',$5,'Воронеж',
      'smoke',4,now()-interval '3 hours',now()-interval '1 hour',3600,0,3600,1080,540,540,2520,'card',now()-interval '1 day',now())`,
  [bookingId, `R-SMOKE-${suffix.toUpperCase()}`, clientId, venueId, clientEmail]);
  await pool.query(`insert into booking_rooms (
      booking_id, room_id, title_snapshot, price_per_hour_snapshot, amount, is_primary
    ) values ($1::uuid,$2::uuid,'Smoke Review Room',1800,3600,true)`, [bookingId, roomId]);

  const clientLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: clientEmail, password } });
  const partnerLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: partnerEmail, password } });
  const adminLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: "admin@rooms.ru", password: adminPassword } });

  const completed = await api<{ status: string }>(`/v1/bookings/${bookingId}/complete`, { method: "POST", token: clientLogin.accessToken });
  assert.equal(completed.status, "completed");
  const submitted = await api<{ id: string; status: string }>(`/v1/bookings/${bookingId}/review`, {
    method: "POST",
    token: clientLogin.accessToken,
    body: { roomId, rating: 5, body: "Отличное тестовое помещение, всё прошло удобно." },
  });
  reviewId = submitted.id;
  assert.equal(submitted.status, "pending");

  const pending = await api<Array<{ id: string }>>("/v1/admin/reviews?status=pending&limit=200", { token: adminLogin.accessToken });
  assert.ok(pending.some((review) => review.id === reviewId));
  const approved = await api<{ status: string }>(`/v1/admin/reviews/${reviewId}`, {
    method: "PATCH",
    token: adminLogin.accessToken,
    body: { status: "approved" },
  });
  assert.equal(approved.status, "approved");

  const partnerReviews = await api<Array<{ id: string }>>("/v1/partner/reviews", { token: partnerLogin.accessToken });
  assert.ok(partnerReviews.some((review) => review.id === reviewId));
  const replied = await api<{ partnerReply: string }>(`/v1/partner/reviews/${reviewId}/reply`, {
    method: "PATCH",
    token: partnerLogin.accessToken,
    body: { body: "Спасибо за отзыв. Будем рады видеть вас снова." },
  });
  assert.match(replied.partnerReply, /Спасибо/u);

  const publicPage = await api<{ items: Array<{ id: string; partnerReply: string }> }>(`/v1/rooms/smoke-review-room-${suffix}/reviews`);
  const published = publicPage.items.find((review) => review.id === reviewId);
  assert.match(published?.partnerReply ?? "", /Спасибо/u);
  const aggregate = await pool.query<{ rating: string; count: number }>(
    "select rating_cached::text as rating, review_count_cached as count from rooms where id = $1::uuid",
    [roomId],
  );
  assert.deepEqual(aggregate.rows[0], { rating: "5.0", count: 1 });
  console.log(`Review lifecycle smoke passed for booking ${bookingId}.`);
} finally {
  await pool.query("delete from notification_deliveries where dedupe_key like $1 or dedupe_key like $2", [`%${bookingId}%`, `%${reviewId}%`]).catch(() => undefined);
  await pool.query("delete from audit_log where actor_id = any($1::uuid[]) or (entity_type = 'review' and entity_id = $2)", [[clientId, partnerId], reviewId]).catch(() => undefined);
  await pool.query("delete from reviews where booking_id = $1::uuid", [bookingId]).catch(() => undefined);
  await pool.query("delete from bookings where id = $1::uuid", [bookingId]).catch(() => undefined);
  await pool.query("delete from venues where id = $1::uuid", [venueId]).catch(() => undefined);
  await pool.query("delete from users where id = any($1::uuid[])", [[clientId, partnerId]]).catch(() => undefined);
  const cleanup = await pool.query<{ users: number; venues: number; bookings: number; reviews: number }>(`
    select
      (select count(*)::integer from users where id = any($1::uuid[])) as users,
      (select count(*)::integer from venues where id = $2::uuid) as venues,
      (select count(*)::integer from bookings where id = $3::uuid) as bookings,
      (select count(*)::integer from reviews where booking_id = $3::uuid) as reviews
  `, [[clientId, partnerId], venueId, bookingId]);
  assert.deepEqual(cleanup.rows[0], { users: 0, venues: 0, bookings: 0, reviews: 0 });
  console.log("Review lifecycle smoke cleanup passed.");
  await pool.end();
}
