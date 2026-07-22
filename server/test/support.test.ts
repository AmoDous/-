import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { hashPassword, MemoryAuthRepository } from "../src/auth.js";
import { MemoryBookingRepository, type BookingCreateInput } from "../src/bookings.js";
import { demoRooms, demoVenues, roomIds, venueIds } from "../src/catalog.js";
import { MemorySupportRepository } from "../src/support.js";

test("support cases are role-scoped and booking cancellation releases inventory", async () => {
  const clientId = "70000000-0000-4000-8000-000000000001";
  const otherClientId = "70000000-0000-4000-8000-000000000002";
  const partnerId = "70000000-0000-4000-8000-000000000003";
  const adminId = "70000000-0000-4000-8000-000000000004";
  const password = "rooms-support-2026";
  const passwordHash = await hashPassword(password);
  const authRepository = new MemoryAuthRepository([
    { id: clientId, role: "client", name: "Support Client", email: "support.client@rooms.test", phone: "+79000000011", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
    { id: otherClientId, role: "client", name: "Other Client", email: "support.other@rooms.test", phone: "+79000000012", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
    { id: partnerId, role: "partner", name: "Support Partner", email: "support.partner@rooms.test", phone: "+79000000013", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
    { id: adminId, role: "admin", name: "Support Admin", email: "support.admin@rooms.test", phone: "+79000000014", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
  ]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const room = demoRooms.find((item) => item.id === roomIds.kosmos)!;
  const bookingRepository = new MemoryBookingRepository({ partners: [{ userId: partnerId, venue }] });
  const supportRepository = new MemorySupportRepository(bookingRepository);
  const bookingInput = (startsAt: string, endsAt: string): BookingCreateInput => ({
    clientId,
    clientName: "Support Client",
    clientPhone: "+79000000011",
    clientEmail: "support.client@rooms.test",
    venue,
    rooms: [{
      id: room.id,
      slug: room.slug,
      title: room.title,
      type: room.type,
      capacityMax: room.capacityMax,
      pricePerHour: room.pricePerHour,
      amount: room.pricePerHour * 2,
      isPrimary: true,
      bufferMinutes: room.bufferMinutes,
    }],
    services: [],
    startsAt,
    endsAt,
    guests: 8,
    eventType: "birthday",
    eventName: null,
    onSitePaymentMethod: "card",
    comment: "",
    money: {
      roomTotal: room.pricePerHour * 2,
      serviceTotal: 0,
      total: room.pricePerHour * 2,
      prepayment: 960,
      remainingOnSite: room.pricePerHour * 2 - 960,
      currency: "RUB",
    },
    commission: 480,
    partnerAmount: 480,
    legal: { termsVersion: "test", privacyVersion: "test", acceptedAt: new Date().toISOString() },
    ip: null,
    userAgent: null,
  });
  const booking = await bookingRepository.create(bookingInput("2026-08-10T10:00:00.000Z", "2026-08-10T12:00:00.000Z"));
  await bookingRepository.confirmByPartner(partnerId, booking.id);

  const app = buildApp({ logger: false, authRepository, bookingRepository, supportRepository });
  await app.ready();
  const login = async (email: string) => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: email, password } });
    assert.equal(response.statusCode, 200);
    return { authorization: `Bearer ${response.json().accessToken as string}` };
  };
  const clientHeaders = await login("support.client@rooms.test");
  const otherClientHeaders = await login("support.other@rooms.test");
  const partnerHeaders = await login("support.partner@rooms.test");
  const adminHeaders = await login("support.admin@rooms.test");

  const adminQueue = await app.inject({ method: "GET", url: "/v1/admin/bookings?statusGroup=all", headers: adminHeaders });
  assert.equal(adminQueue.statusCode, 200);
  assert.equal(adminQueue.json()[0].id, booking.id);
  assert.equal(adminQueue.json()[0].clientPhone, "+79000000011");

  const forbidden = await app.inject({ method: "GET", url: `/v1/bookings/${booking.id}/support`, headers: otherClientHeaders });
  assert.equal(forbidden.statusCode, 404);

  const opened = await app.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/support`,
    headers: clientHeaders,
    payload: { topic: "Payment question", body: "Please explain when the prepayment will be returned." },
  });
  assert.equal(opened.statusCode, 201);
  assert.equal(opened.json().status, "open");
  const supportId = opened.json().id as string;

  const partnerQueue = await app.inject({ method: "GET", url: "/v1/partner/support?status=all", headers: partnerHeaders });
  assert.equal(partnerQueue.statusCode, 200);
  assert.equal(partnerQueue.json()[0].id, supportId);

  const partnerReply = await app.inject({
    method: "POST",
    url: `/v1/support/${supportId}/messages`,
    headers: partnerHeaders,
    payload: { body: "The venue has sent the booking details to Rooms." },
  });
  assert.equal(partnerReply.statusCode, 201);
  assert.equal(partnerReply.json().messages.at(-1).senderRole, "partner");

  const working = await app.inject({
    method: "PATCH",
    url: `/v1/admin/support/${supportId}`,
    headers: adminHeaders,
    payload: { status: "working" },
  });
  assert.equal(working.statusCode, 200);
  assert.equal(working.json().assignedTo, adminId);

  const closed = await app.inject({
    method: "PATCH",
    url: `/v1/admin/support/${supportId}`,
    headers: adminHeaders,
    payload: { status: "closed" },
  });
  assert.equal(closed.statusCode, 200);
  assert.ok(closed.json().closedAt);

  const replyToClosed = await app.inject({
    method: "POST",
    url: `/v1/support/${supportId}/messages`,
    headers: clientHeaders,
    payload: { body: "This message must be rejected because the case is closed." },
  });
  assert.equal(replyToClosed.statusCode, 409);
  assert.equal(replyToClosed.json().code, "SUPPORT_CASE_CLOSED");

  const cancelled = await app.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/cancel`,
    headers: clientHeaders,
    payload: { reason: "Plans have changed" },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, "cancelled");
  assert.equal(cancelled.json().paymentStatus, "unpaid");

  const replacement = await bookingRepository.create(bookingInput("2026-08-10T10:00:00.000Z", "2026-08-10T12:00:00.000Z"));
  const replacementConfirmed = await bookingRepository.confirmByPartner(partnerId, replacement.id);
  assert.equal(replacementConfirmed?.status, "awaiting_payment");
  bookingRepository.completePayment(clientId, replacement.id);

  const paidCancellation = await app.inject({
    method: "POST",
    url: `/v1/admin/bookings/${replacement.id}/cancel`,
    headers: adminHeaders,
    payload: { reason: "Venue cannot host the event" },
  });
  assert.equal(paidCancellation.statusCode, 200);
  assert.equal(paidCancellation.json().paymentStatus, "refund_pending");
  assert.equal(paidCancellation.json().cancelledBy, "admin");

  await app.close();
});
