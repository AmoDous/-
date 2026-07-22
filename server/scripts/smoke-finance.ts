import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  GatewayOrder,
  GatewayOrderInput,
  GatewayRefundInput,
  GatewayRefundStatus,
  GatewayRefundSubmission,
  PaymentGateway,
  VerifiedPaymentEvent,
} from "../src/paymentGateway.js";
import { PostgresRefundRepository, processRefundBatch } from "../src/refunds.js";
import { postgresPoolConfig } from "../src/storage.js";

class SmokeRefundGateway implements PaymentGateway {
  readonly provider = "sber" as const;
  submitted = 0;
  private refunded = false;

  async registerOrder(_input: GatewayOrderInput): Promise<GatewayOrder> { throw new Error("not used"); }
  async verifyCallback(_payload: unknown): Promise<VerifiedPaymentEvent> { throw new Error("not used"); }

  async submitRefund(input: GatewayRefundInput): Promise<GatewayRefundSubmission> {
    this.submitted += 1;
    this.refunded = true;
    return { providerRefundId: `SBER-SMOKE-${input.refundId}`, providerPayload: { smoke: true } };
  }

  async checkRefund(input: GatewayRefundInput): Promise<GatewayRefundStatus> {
    return {
      confirmed: this.refunded,
      refundedAmount: this.refunded ? input.amount : 0,
      providerPayload: { smoke: true, paymentState: this.refunded ? "REFUNDED" : "DEPOSITED" },
    };
  }
}

const apiBaseUrl = String(process.env.API_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/u, "");
const pool = new Pool({ ...postgresPoolConfig(), max: 1, application_name: "rooms-finance-smoke" });
const clientId = randomUUID();
const partnerId = randomUUID();
const venueId = randomUUID();
const roomId = randomUUID();
const payoutBookingId = randomUUID();
const refundBookingId = randomUUID();
const payoutPaymentId = randomUUID();
const refundPaymentId = randomUUID();
const suffix = clientId.slice(0, 8);
const clientEmail = `smoke.finance.client.${suffix}@rooms.test`;
const partnerEmail = `smoke.finance.partner.${suffix}@rooms.test`;
const password = "rooms2026";
const adminPassword = process.env.DEMO_ADMIN_PASSWORD?.trim() || password;
const accountantPassword = process.env.DEMO_ACCOUNTANT_PASSWORD?.trim() || password;
const settlementAccount = "40702810900000001234";
const replacementSettlementAccount = "40702810900000005678";
let payoutId = "";
let refundId = "";

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
  if (!passwordHash) throw new Error("Seeded partner account is required for the finance smoke test.");
  await pool.query(`insert into users (id, role, name, email, phone, city, password_hash, password_reset_required)
    values
      ($1::uuid,'client','Smoke Finance Client',$2,$3,'Voronezh',$4,false),
      ($5::uuid,'partner','Smoke Finance Partner',$6,null,'Voronezh',$4,false)`, [
    clientId,
    clientEmail,
    `+7902${suffix.replace(/[^0-9]/gu, "").padEnd(7, "0").slice(0, 7)}`,
    passwordHash,
    partnerId,
    partnerEmail,
  ]);
  await pool.query(`insert into venues (
      id, slug, title, city, address, publication_status, verification_status, cabinet_status, partner_mode
    ) values ($1::uuid,$2,'Smoke Finance Venue','Voronezh','Finance test address','published','verified','active','catalog')`,
  [venueId, `smoke-finance-venue-${suffix}`]);
  await pool.query("insert into venue_members (venue_id, user_id, member_role) values ($1::uuid,$2::uuid,'manager')", [venueId, partnerId]);
  await pool.query(`insert into rooms (
      id, venue_id, slug, title, room_type, subtitle, description, rules,
      capacity_max, price_per_hour, minimum_hours, opens_at, closes_at, closes_next_day, status
    ) values ($1::uuid,$2::uuid,$3,'Smoke Finance Room','lounge','Finance room',
      'Room for finance lifecycle verification.','Temporary smoke-test record.',10,1600,2,'10:00','00:00',true,'published')`,
  [roomId, venueId, `smoke-finance-room-${suffix}`]);

  const insertBooking = async (bookingId: string, publicNumber: string, status: "completed" | "paid", days: number) => {
    await pool.query(`insert into bookings (
        id, public_number, client_id, venue_id, status, client_name, client_phone, client_email, city,
        event_type, guests, starts_at, ends_at, room_total, service_total, total, prepayment,
        commission, partner_amount, remaining_on_site, on_site_payment_method, completed_at, created_at, updated_at
      ) values ($1::uuid,$2,$3::uuid,$4::uuid,$5::booking_status,'Smoke Finance Client','+79020000000',$6,'Voronezh',
        'smoke',4,now()+($7 || ' days')::interval,now()+($7 || ' days')::interval+interval '2 hours',
        3200,0,3200,960,480,480,2240,'card',case when $5 = 'completed' then now() else null end,now(),now())`,
    [bookingId, publicNumber, clientId, venueId, status, clientEmail, days]);
    await pool.query(`insert into booking_rooms (
        booking_id, room_id, title_snapshot, price_per_hour_snapshot, amount, is_primary
      ) values ($1::uuid,$2::uuid,'Smoke Finance Room',1600,3200,true)`, [bookingId, roomId]);
  };
  await insertBooking(payoutBookingId, `R-FIN-PAYOUT-${suffix.toUpperCase()}`, "completed", -7);
  await insertBooking(refundBookingId, `R-FIN-REFUND-${suffix.toUpperCase()}`, "paid", 7);
  await pool.query(`insert into room_reservations (
      room_id, booking_id, source_type, source_id, period, active, details, created_by
    ) values ($1::uuid,$2::uuid,'booking',$2::uuid,tstzrange(now()+interval '7 days',now()+interval '7 days 2 hours','[)'),true,'{}',$3::uuid)`,
  [roomId, refundBookingId, partnerId]);
  const insertPayment = async (paymentId: string, bookingId: string, label: string, provider = "rooms_demo") => {
    await pool.query(`insert into payment_transactions (
        id, booking_id, provider, provider_payment_id, idempotency_key, status, amount, currency, paid_at
      ) values ($1::uuid,$2::uuid,$5,$3,$4,'paid',960,'RUB',now())`,
    [paymentId, bookingId, `SMOKE-FIN-${label}-${suffix}`, `smoke-finance-${bookingId}`, provider]);
  };
  await insertPayment(payoutPaymentId, payoutBookingId, "PAYOUT");
  await insertPayment(refundPaymentId, refundBookingId, "REFUND", "sber");

  const clientLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: clientEmail, password } });
  const partnerLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: partnerEmail, password } });
  const adminLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: "admin@rooms.ru", password: adminPassword } });
  const accountantLogin = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: "accountant@rooms.ru", password: accountantPassword } });

  const forbidden = await fetch(`${apiBaseUrl}/v1/accounting/overview`, { headers: { Authorization: `Bearer ${clientLogin.accessToken}` } });
  assert.equal(forbidden.status, 403);
  const bank = await api<{ accountLastFour: string; verifiedAt: string | null }>("/v1/partner/bank-account", {
    method: "PUT",
    token: partnerLogin.accessToken,
    body: { bankName: "Smoke Finance Bank", bik: "044525225", settlementAccount },
  });
  assert.equal(bank.accountLastFour, "1234");
  assert.equal(bank.verifiedAt, null);
  const storedBank = await pool.query<{ settlement_account_ciphertext: string; account_last_four: string }>(`
    select settlement_account_ciphertext, account_last_four from venue_bank_accounts where venue_id = $1::uuid
  `, [venueId]);
  assert.match(storedBank.rows[0]!.settlement_account_ciphertext, /^enc:v1:/u);
  assert.equal(storedBank.rows[0]!.settlement_account_ciphertext.includes(settlementAccount), false);
  assert.equal(storedBank.rows[0]!.account_last_four, "1234");

  const verified = await api<{ verifiedAt: string }>(`/v1/accounting/bank-accounts/${venueId}/verify`, {
    method: "POST",
    token: accountantLogin.accessToken,
  });
  assert.ok(verified.verifiedAt);
  const candidates = await api<Array<{ bookingId: string; amount: number; blockedReason: string | null }>>("/v1/accounting/payout-candidates", {
    token: accountantLogin.accessToken,
  });
  const candidate = candidates.find((item) => item.bookingId === payoutBookingId);
  assert.equal(candidate?.bookingId, payoutBookingId);
  assert.equal(candidate?.amount, 480);
  assert.equal(candidate?.blockedReason, null);
  const payouts = await api<Array<{ id: string; status: string; amount: number }>>("/v1/accounting/payouts", {
    method: "POST",
    token: accountantLogin.accessToken,
    body: { bookingIds: [payoutBookingId] },
  });
  payoutId = payouts[0]!.id;
  assert.equal(payouts[0]!.status, "sent");
  assert.equal(payouts[0]!.amount, 480);
  const storedPayoutDestination = await pool.query<{ destination_account_ciphertext: string; account_last_four: string }>(`
    select destination_account_ciphertext, account_last_four from payout_batches where id = $1::uuid
  `, [payoutId]);
  assert.equal(storedPayoutDestination.rows[0]!.destination_account_ciphertext, storedBank.rows[0]!.settlement_account_ciphertext);
  assert.equal(storedPayoutDestination.rows[0]!.destination_account_ciphertext.includes(settlementAccount), false);
  assert.equal(storedPayoutDestination.rows[0]!.account_last_four, "1234");
  await api("/v1/partner/bank-account", {
    method: "PUT",
    token: partnerLogin.accessToken,
    body: { bankName: "Smoke Replacement Bank", bik: "044525999", settlementAccount: replacementSettlementAccount },
  });
  const partnerPayouts = await api<Array<{ id: string; accountLastFour: string; status: string }>>(
    "/v1/partner/payouts?status=all",
    { token: partnerLogin.accessToken },
  );
  const partnerPayout = partnerPayouts.find((item) => item.id === payoutId);
  assert.equal(partnerPayout?.accountLastFour, "1234");
  assert.equal(partnerPayout?.status, "sent");
  const completedPayout = await api<{ status: string; providerPayoutId: string }>(`/v1/accounting/payouts/${payoutId}/complete`, {
    method: "POST",
    token: adminLogin.accessToken,
    body: { providerOperationId: `SMOKE-PAYOUT-${suffix}` },
  });
  assert.equal(completedPayout.status, "paid");

  const cancelled = await api<{ paymentStatus: string }>(`/v1/admin/bookings/${refundBookingId}/cancel`, {
    method: "POST",
    token: adminLogin.accessToken,
    body: { reason: "Smoke finance refund" },
  });
  assert.equal(cancelled.paymentStatus, "refund_pending");
  const refunds = await api<Array<{ id: string; bookingId: string; status: string }>>("/v1/accounting/refunds?status=refund_pending", {
    token: accountantLogin.accessToken,
  });
  refundId = refunds.find((item) => item.bookingId === refundBookingId)!.id;
  const manualRefund = await fetch(`${apiBaseUrl}/v1/accounting/refunds/${refundId}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accountantLogin.accessToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(manualRefund.status, 409);
  const refundGateway = new SmokeRefundGateway();
  const refundSummary = await processRefundBatch(new PostgresRefundRepository(pool), refundGateway, 20);
  assert.deepEqual(refundSummary, { claimed: 1, succeeded: 1, failed: 0 });
  assert.equal(refundGateway.submitted, 1);
  const duplicateRefundSummary = await processRefundBatch(new PostgresRefundRepository(pool), refundGateway, 20);
  assert.deepEqual(duplicateRefundSummary, { claimed: 0, succeeded: 0, failed: 0 });
  const overview = await api<{ paid: number; refunded: number }>("/v1/accounting/overview", { token: accountantLogin.accessToken });
  assert.ok(overview.paid >= 480);
  assert.ok(overview.refunded >= 960);

  const state = await pool.query<{ payout: string; refund: string; payment: string; audits: number }>(`
    select
      (select status::text from payout_batches where id = $1::uuid) as payout,
      (select status::text from refunds where id = $2::uuid) as refund,
      (select status::text from payment_transactions where id = $3::uuid) as payment,
      (select count(*)::integer from audit_log
        where entity_id = any($4::text[])) as audits
  `, [payoutId, refundId, refundPaymentId, [venueId, payoutId, refundId, refundBookingId]]);
  assert.equal(state.rows[0]!.payout, "paid");
  assert.equal(state.rows[0]!.refund, "refunded");
  assert.equal(state.rows[0]!.payment, "refunded");
  assert.ok(state.rows[0]!.audits >= 6);
  console.log(`Finance smoke passed for payout ${payoutId} and refund ${refundId}.`);
} finally {
  await pool.query("delete from notification_deliveries where venue_id = $1::uuid or dedupe_key like $2 or dedupe_key like $3", [
    venueId, `%${payoutBookingId}%`, `%${refundBookingId}%`,
  ]).catch(() => undefined);
  await pool.query("delete from audit_log where entity_id = any($1::text[])", [[venueId, payoutId, refundId, payoutBookingId, refundBookingId].filter(Boolean)]).catch(() => undefined);
  if (payoutId) await pool.query("delete from payout_batches where id = $1::uuid", [payoutId]).catch(() => undefined);
  if (refundId) await pool.query("delete from refunds where id = $1::uuid", [refundId]).catch(() => undefined);
  await pool.query("delete from payment_transactions where id = any($1::uuid[])", [[payoutPaymentId, refundPaymentId]]).catch(() => undefined);
  await pool.query("delete from bookings where id = any($1::uuid[])", [[payoutBookingId, refundBookingId]]).catch(() => undefined);
  await pool.query("delete from venues where id = $1::uuid", [venueId]).catch(() => undefined);
  await pool.query("delete from users where id = any($1::uuid[])", [[clientId, partnerId]]).catch(() => undefined);
  const cleanup = await pool.query<{ users: number; venues: number; bookings: number; payouts: number; refunds: number }>(`
    select
      (select count(*)::integer from users where id = any($1::uuid[])) as users,
      (select count(*)::integer from venues where id = $2::uuid) as venues,
      (select count(*)::integer from bookings where id = any($3::uuid[])) as bookings,
      (select count(*)::integer from payout_batches where id = $4::uuid) as payouts,
      (select count(*)::integer from refunds where id = $5::uuid) as refunds
  `, [
    [clientId, partnerId],
    venueId,
    [payoutBookingId, refundBookingId],
    payoutId || "00000000-0000-0000-0000-000000000000",
    refundId || "00000000-0000-0000-0000-000000000000",
  ]);
  assert.deepEqual(cleanup.rows[0], { users: 0, venues: 0, bookings: 0, payouts: 0, refunds: 0 });
  console.log("Finance smoke cleanup passed.");
  await pool.end();
}
