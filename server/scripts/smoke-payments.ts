import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { FinanceCipher, PostgresFinanceRepository } from "../src/finance.js";
import type {
  GatewayOrder,
  GatewayOrderInput,
  GatewayRefundInput,
  GatewayRefundStatus,
  GatewayRefundSubmission,
  PaymentGateway,
  VerifiedPaymentEvent,
} from "../src/paymentGateway.js";
import { PostgresPaymentRepository } from "../src/payments.js";
import { DemoFiscalReceiptProvider, PostgresFiscalReceiptRepository, processFiscalReceiptBatch } from "../src/receipts.js";
import { postgresPoolConfig } from "../src/storage.js";

class SmokePaymentGateway implements PaymentGateway {
  readonly provider = "sber" as const;

  async registerOrder(input: GatewayOrderInput): Promise<GatewayOrder> {
    return {
      provider: "sber",
      providerPaymentId: `SBER-SMOKE-${input.paymentId}`,
      redirectUrl: `https://bank.rooms.test/pay/${input.paymentId}`,
      providerPayload: { smoke: true },
    };
  }

  async verifyCallback(value: unknown): Promise<VerifiedPaymentEvent> {
    const payload = value as { paymentId: string; providerPaymentId: string; eventKey: string; amount?: number };
    return {
      provider: "sber",
      providerPaymentId: payload.providerPaymentId,
      providerEventKey: payload.eventKey,
      orderNumber: payload.paymentId,
      operation: "deposited",
      successful: true,
      depositedAmount: payload.amount ?? 960,
      currency: "RUB",
      maskedCard: "411111******1111",
      providerPayload: { orderStatus: 2, paymentAmountInfo: { paymentState: "DEPOSITED", depositedAmount: 96_000 } },
    };
  }

  async submitRefund(input: GatewayRefundInput): Promise<GatewayRefundSubmission> {
    return { providerRefundId: `SBER-SMOKE-REFUND-${input.refundId}`, providerPayload: { smoke: true } };
  }

  async checkRefund(input: GatewayRefundInput): Promise<GatewayRefundStatus> {
    return { confirmed: false, refundedAmount: 0, providerPayload: { paymentId: input.paymentId } };
  }
}

const pool = new Pool({ ...postgresPoolConfig(), max: 2, application_name: "rooms-payments-smoke" });
const repository = new PostgresPaymentRepository(pool, new SmokePaymentGateway(), "https://rooms.example/");
const finance = new PostgresFinanceRepository(pool, new FinanceCipher("rooms-payments-smoke-secret-at-least-32-bytes"));
const receiptRepository = new PostgresFiscalReceiptRepository(pool);
const clientId = randomUUID();
const venueId = randomUUID();
const roomId = randomUUID();
const paidBookingId = randomUUID();
const lateBookingId = randomUUID();
const suffix = clientId.slice(0, 8);
const paymentIds: string[] = [];
let receiptIds: string[] = [];

async function insertBooking(id: string, publicNumber: string, startsInDays: number): Promise<void> {
  await pool.query(`insert into bookings (
      id, public_number, client_id, venue_id, status, client_name, client_phone, client_email, city,
      event_type, guests, starts_at, ends_at, room_total, service_total, total, prepayment,
      commission, partner_amount, remaining_on_site, on_site_payment_method, payment_hold_expires_at
    ) values (
      $1::uuid,$2,$3::uuid,$4::uuid,'awaiting_payment','Smoke Payment Client','+79020000000',$5,'Voronezh',
      'smoke',4,now()+($6 || ' days')::interval,now()+($6 || ' days')::interval+interval '2 hours',
      3200,0,3200,960,480,480,2240,'card',now()+interval '15 minutes'
    )`, [id, publicNumber, clientId, venueId, `smoke.payments.${suffix}@rooms.test`, startsInDays]);
  await pool.query(`insert into booking_rooms (
      booking_id, room_id, title_snapshot, price_per_hour_snapshot, amount, is_primary
    ) values ($1::uuid,$2::uuid,'Smoke Payment Room',1600,3200,true)`, [id, roomId]);
  await pool.query(`insert into room_reservations (
      room_id, booking_id, source_type, source_id, period, expires_at, active, details
    ) values (
      $1::uuid,$2::uuid,'payment_hold',$2::uuid,
      tstzrange(now()+($3 || ' days')::interval,now()+($3 || ' days')::interval+interval '2 hours','[)'),
      now()+interval '15 minutes',true,'{}'
    )`, [roomId, id, startsInDays]);
}

try {
  const seeded = await pool.query<{ password_hash: string | null }>("select password_hash from users where email = 'manager@kids-loft.ru' limit 1");
  const passwordHash = seeded.rows[0]?.password_hash;
  if (!passwordHash) throw new Error("Seeded Rooms accounts are required for the payment smoke test.");
  await pool.query(`insert into users (id, role, name, email, phone, city, password_hash, password_reset_required)
    values ($1::uuid,'client','Smoke Payment Client',$2,$3,'Voronezh',$4,false)`, [
    clientId,
    `smoke.payments.${suffix}@rooms.test`,
    `+7903${suffix.replace(/[^0-9]/gu, "").padEnd(7, "0").slice(0, 7)}`,
    passwordHash,
  ]);
  await pool.query(`insert into venues (
      id, slug, title, city, address, publication_status, verification_status, cabinet_status, partner_mode
    ) values ($1::uuid,$2,'Smoke Payment Venue','Voronezh','Payment smoke address','published','verified','active','catalog')`,
  [venueId, `smoke-payment-venue-${suffix}`]);
  await pool.query(`insert into rooms (
      id, venue_id, slug, title, room_type, subtitle, description, rules,
      capacity_max, price_per_hour, minimum_hours, opens_at, closes_at, closes_next_day, status
    ) values ($1::uuid,$2::uuid,$3,'Smoke Payment Room','lounge','Payment room',
      'Room for payment lifecycle verification.','Temporary smoke-test record.',10,1600,2,'10:00','00:00',true,'published')`,
  [roomId, venueId, `smoke-payment-room-${suffix}`]);
  await insertBooking(paidBookingId, `R-PAY-OK-${suffix.toUpperCase()}`, 12);
  await insertBooking(lateBookingId, `R-PAY-LATE-${suffix.toUpperCase()}`, 14);

  const paidIntent = await repository.createIntent(clientId, paidBookingId);
  paymentIds.push(paidIntent.paymentId);
  assert.equal(paidIntent.provider, "sber");
  assert.match(paidIntent.redirectUrl, /^https:\/\//u);
  const paidEvent = { paymentId: paidIntent.paymentId, providerPaymentId: paidIntent.providerPaymentId, eventKey: `paid-${suffix}` };
  const paid = await repository.processProviderCallback("sber", paidEvent);
  assert.equal(paid.outcome, "paid");
  assert.equal(paid.payment.status, "paid");
  const duplicate = await repository.processProviderCallback("sber", paidEvent);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.outcome, "paid");

  const lateIntent = await repository.createIntent(clientId, lateBookingId);
  paymentIds.push(lateIntent.paymentId);
  await pool.query("update bookings set payment_hold_expires_at = now() - interval '1 minute' where id = $1::uuid", [lateBookingId]);
  await pool.query("update room_reservations set active = false, expires_at = now() - interval '1 minute' where booking_id = $1::uuid", [lateBookingId]);
  const late = await repository.processProviderCallback("sber", {
    paymentId: lateIntent.paymentId,
    providerPaymentId: lateIntent.providerPaymentId,
    eventKey: `late-${suffix}`,
  });
  assert.equal(late.outcome, "refund_pending");
  assert.equal(late.payment.status, "paid");

  const state = await pool.query<{
    paid_booking: string;
    late_booking: string;
    webhooks: number;
    sale_receipts: number;
    refunds: number;
  }>(`select
      (select status::text from bookings where id = $1::uuid) as paid_booking,
      (select status::text from bookings where id = $2::uuid) as late_booking,
      (select count(*)::integer from payment_webhook_events where payment_id = any($3::uuid[])) as webhooks,
      (select count(*)::integer from fiscal_receipts where payment_id = any($3::uuid[]) and receipt_type = 'sale' and status = 'queued') as sale_receipts,
      (select count(*)::integer from refunds where payment_id = any($3::uuid[]) and status = 'refund_pending') as refunds`,
  [paidBookingId, lateBookingId, paymentIds]);
  assert.deepEqual(state.rows[0], { paid_booking: "paid", late_booking: "expired", webhooks: 2, sale_receipts: 2, refunds: 1 });
  const queuedReceipts = await pool.query<{ id: string }>(`
    select id::text from fiscal_receipts where payment_id = any($1::uuid[]) order by created_at, id
  `, [paymentIds]);
  receiptIds = queuedReceipts.rows.map((row) => row.id);
  assert.equal(receiptIds.length, 2);
  const cancelledReceipt = await receiptRepository.cancel(
    receiptIds[0]!,
    "50000000-0000-4000-8000-000000000003",
    "accountant",
  );
  assert.deepEqual(cancelledReceipt, { outcome: "updated", status: "cancelled" });
  const retriedReceipt = await receiptRepository.retry(
    receiptIds[0]!,
    "50000000-0000-4000-8000-000000000003",
    "accountant",
  );
  assert.deepEqual(retriedReceipt, { outcome: "updated", status: "queued" });
  await pool.query("update fiscal_receipts set created_at = '2000-01-01T00:00:00Z' where payment_id = any($1::uuid[])", [paymentIds]);
  const worker = await processFiscalReceiptBatch(receiptRepository, new DemoFiscalReceiptProvider(), 2);
  assert.deepEqual(worker, { claimed: 2, succeeded: 2, failed: 0 });
  assert.deepEqual(await processFiscalReceiptBatch(receiptRepository, new DemoFiscalReceiptProvider(), 2), { claimed: 0, succeeded: 0, failed: 0 });
  const receipts = await finance.listReceipts("succeeded", 20);
  assert.equal(receipts.filter((receipt) => paymentIds.includes(receipt.paymentId)).length, 2);
  assert.ok(receipts.filter((receipt) => paymentIds.includes(receipt.paymentId)).every((receipt) => (
    receipt.receiptType === "sale"
    && receipt.provider === "rooms_demo_cashbox"
    && Boolean(receipt.fiscalDocumentNumber)
  )));
  const receiptAudits = await pool.query<{ count: number }>(`
    select count(*)::integer from audit_log
    where entity_type = 'fiscal_receipt' and entity_id = any($1::text[])
  `, [receiptIds]);
  assert.equal(receiptAudits.rows[0]?.count, 2);
  console.log(`Payment smoke passed for ${paidIntent.paymentId} and late payment ${lateIntent.paymentId}.`);
} finally {
  if (paymentIds.length) {
    if (receiptIds.length) {
      await pool.query("delete from audit_log where entity_type = 'fiscal_receipt' and entity_id = any($1::text[])", [receiptIds]).catch(() => undefined);
    }
    await pool.query("delete from payment_webhook_events where payment_id = any($1::uuid[])", [paymentIds]).catch(() => undefined);
    await pool.query("delete from refunds where payment_id = any($1::uuid[])", [paymentIds]).catch(() => undefined);
    await pool.query("delete from fiscal_receipts where payment_id = any($1::uuid[])", [paymentIds]).catch(() => undefined);
    await pool.query("delete from payment_transactions where id = any($1::uuid[])", [paymentIds]).catch(() => undefined);
  }
  await pool.query("delete from bookings where id = any($1::uuid[])", [[paidBookingId, lateBookingId]]).catch(() => undefined);
  await pool.query("delete from venues where id = $1::uuid", [venueId]).catch(() => undefined);
  await pool.query("delete from users where id = $1::uuid", [clientId]).catch(() => undefined);
  const cleanup = await pool.query<{ users: number; venues: number; bookings: number }>(`select
      (select count(*)::integer from users where id = $1::uuid) as users,
      (select count(*)::integer from venues where id = $2::uuid) as venues,
      (select count(*)::integer from bookings where id = any($3::uuid[])) as bookings`,
  [clientId, venueId, [paidBookingId, lateBookingId]]);
  assert.deepEqual(cleanup.rows[0], { users: 0, venues: 0, bookings: 0 });
  console.log("Payment smoke cleanup passed.");
  await pool.end();
}
