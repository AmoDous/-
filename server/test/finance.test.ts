import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { hashPassword, MemoryAuthRepository } from "../src/auth.js";
import { MemoryBookingRepository, type BookingCreateInput } from "../src/bookings.js";
import { demoRooms, demoVenues, roomIds, venueIds } from "../src/catalog.js";
import { MemoryFinanceRepository } from "../src/finance.js";
import { MemorySupportRepository } from "../src/support.js";

test("accounting roles process verified payouts and refunds without exposing bank details", async () => {
  const clientId = "71000000-0000-4000-8000-000000000001";
  const partnerId = "71000000-0000-4000-8000-000000000002";
  const adminId = "71000000-0000-4000-8000-000000000003";
  const accountantId = "71000000-0000-4000-8000-000000000004";
  const password = "rooms-finance-2026";
  const passwordHash = await hashPassword(password);
  const authRepository = new MemoryAuthRepository([
    { id: clientId, role: "client", name: "Finance Client", email: "finance.client@rooms.test", phone: "+79000000101", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
    { id: partnerId, role: "partner", name: "Finance Partner", email: "finance.partner@rooms.test", phone: "+79000000102", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
    { id: adminId, role: "admin", name: "Finance Admin", email: "finance.admin@rooms.test", phone: "+79000000103", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
    { id: accountantId, role: "accountant", name: "Finance Accountant", email: "finance.accountant@rooms.test", phone: "+79000000104", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
  ]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const room = demoRooms.find((item) => item.id === roomIds.kosmos)!;
  const now = () => new Date("2026-08-20T12:00:00.000Z");
  const bookingRepository = new MemoryBookingRepository({ partners: [{ userId: partnerId, venue }], now });
  const supportRepository = new MemorySupportRepository(bookingRepository, now);
  const financeRepository = new MemoryFinanceRepository(bookingRepository, supportRepository, now);
  const bookingInput = (startsAt: string, endsAt: string): BookingCreateInput => ({
    clientId,
    clientName: "Finance Client",
    clientPhone: "+79000000101",
    clientEmail: "finance.client@rooms.test",
    venue,
    rooms: [{
      id: room.id,
      slug: room.slug,
      title: room.title,
      type: room.type,
      capacityMax: room.capacityMax,
      pricePerHour: room.pricePerHour,
      amount: 3200,
      isPrimary: true,
      bufferMinutes: room.bufferMinutes,
    }],
    services: [],
    startsAt,
    endsAt,
    guests: 6,
    eventType: "birthday",
    eventName: null,
    onSitePaymentMethod: "card",
    comment: "",
    money: { roomTotal: 3200, serviceTotal: 0, total: 3200, prepayment: 960, remainingOnSite: 2240, currency: "RUB" },
    commission: 480,
    partnerAmount: 480,
    legal: { termsVersion: "test", privacyVersion: "test", acceptedAt: now().toISOString() },
    ip: null,
    userAgent: null,
  });
  const readyBooking = await bookingRepository.create(bookingInput("2026-08-10T10:00:00.000Z", "2026-08-10T12:00:00.000Z"));
  await bookingRepository.confirmByPartner(partnerId, readyBooking.id);
  bookingRepository.completePayment(clientId, readyBooking.id);
  await bookingRepository.completeByClient(clientId, readyBooking.id);

  const refundBooking = await bookingRepository.create(bookingInput("2026-08-11T10:00:00.000Z", "2026-08-11T12:00:00.000Z"));
  await bookingRepository.confirmByPartner(partnerId, refundBooking.id);
  bookingRepository.completePayment(clientId, refundBooking.id);

  const app = buildApp({ logger: false, authRepository, bookingRepository, supportRepository, financeRepository });
  await app.ready();
  const login = async (email: string) => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: email, password } });
    assert.equal(response.statusCode, 200);
    return { authorization: `Bearer ${response.json().accessToken as string}` };
  };
  const clientHeaders = await login("finance.client@rooms.test");
  const partnerHeaders = await login("finance.partner@rooms.test");
  const adminHeaders = await login("finance.admin@rooms.test");
  const accountantHeaders = await login("finance.accountant@rooms.test");

  const forbidden = await app.inject({ method: "GET", url: "/v1/accounting/overview", headers: clientHeaders });
  assert.equal(forbidden.statusCode, 403);

  const receipts = await app.inject({ method: "GET", url: "/v1/accounting/receipts?status=all", headers: accountantHeaders });
  assert.equal(receipts.statusCode, 200);
  assert.deepEqual(receipts.json(), []);

  const bank = await app.inject({
    method: "PUT",
    url: "/v1/partner/bank-account",
    headers: partnerHeaders,
    payload: { bankName: "Rooms Test Bank", bik: "044525225", settlementAccount: "40702810900000001234" },
  });
  assert.equal(bank.statusCode, 200);
  assert.equal(bank.json().accountLastFour, "1234");
  assert.equal(bank.json().verifiedAt, null);
  assert.equal("settlementAccount" in bank.json(), false);

  const verify = await app.inject({
    method: "POST",
    url: `/v1/accounting/bank-accounts/${venue.id}/verify`,
    headers: accountantHeaders,
  });
  assert.equal(verify.statusCode, 200);
  assert.ok(verify.json().verifiedAt);

  const candidates = await app.inject({ method: "GET", url: "/v1/accounting/payout-candidates", headers: accountantHeaders });
  assert.equal(candidates.statusCode, 200);
  assert.equal(candidates.json()[0].bookingId, readyBooking.id);
  assert.equal(candidates.json()[0].amount, 480);
  assert.equal(candidates.json()[0].blockedReason, null);

  const createdPayouts = await app.inject({
    method: "POST",
    url: "/v1/accounting/payouts",
    headers: accountantHeaders,
    payload: { bookingIds: [readyBooking.id], scheduledFor: "2026-08-24" },
  });
  assert.equal(createdPayouts.statusCode, 201);
  assert.equal(createdPayouts.json()[0].status, "sent");
  assert.equal(createdPayouts.json()[0].amount, 480);
  const payoutId = createdPayouts.json()[0].id as string;

  const partnerPayouts = await app.inject({ method: "GET", url: "/v1/partner/payouts", headers: partnerHeaders });
  assert.equal(partnerPayouts.statusCode, 200);
  assert.equal(partnerPayouts.json()[0].id, payoutId);
  const completedPayout = await app.inject({
    method: "POST",
    url: `/v1/accounting/payouts/${payoutId}/complete`,
    headers: adminHeaders,
    payload: { providerOperationId: "PAYOUT-TEST-1" },
  });
  assert.equal(completedPayout.statusCode, 200);
  assert.equal(completedPayout.json().status, "paid");

  const cancelled = await app.inject({
    method: "POST",
    url: `/v1/admin/bookings/${refundBooking.id}/cancel`,
    headers: adminHeaders,
    payload: { reason: "Finance test refund" },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().paymentStatus, "refund_pending");
  const refunds = await app.inject({ method: "GET", url: "/v1/accounting/refunds?status=refund_pending", headers: accountantHeaders });
  assert.equal(refunds.statusCode, 200);
  assert.equal(refunds.json()[0].bookingId, refundBooking.id);
  const refundId = refunds.json()[0].id as string;
  const completedRefund = await app.inject({
    method: "POST",
    url: `/v1/accounting/refunds/${refundId}/complete`,
    headers: accountantHeaders,
    payload: { providerOperationId: "REFUND-TEST-1" },
  });
  assert.equal(completedRefund.statusCode, 200);
  assert.equal(completedRefund.json().status, "refunded");

  const overview = await app.inject({ method: "GET", url: "/v1/accounting/overview", headers: adminHeaders });
  assert.equal(overview.statusCode, 200);
  assert.equal(overview.json().paid, 480);
  assert.equal(overview.json().refunded, 960);

  await app.close();
});
