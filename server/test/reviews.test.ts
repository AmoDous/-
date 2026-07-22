import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { hashPassword, MemoryAuthRepository } from "../src/auth.js";
import { MemoryBookingRepository } from "../src/bookings.js";
import { demoRooms, demoVenues, MemoryCatalogRepository, roomIds, venueIds } from "../src/catalog.js";
import { MemoryReviewRepository } from "../src/reviews.js";

test("reviews require a completed visit and pass through moderation before partner reply", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const clientId = "60000000-0000-4000-8000-000000000001";
  const partnerId = "60000000-0000-4000-8000-000000000002";
  const adminId = "60000000-0000-4000-8000-000000000003";
  const password = "rooms-review-2026";
  const passwordHash = await hashPassword(password);
  const authRepository = new MemoryAuthRepository([
    {
      id: clientId,
      role: "client",
      name: "Review Client",
      email: "review.client@rooms.test",
      phone: "+79000000001",
      city: "Voronezh",
      passwordHash,
      passwordResetRequired: false,
      blockedAt: null,
    },
    {
      id: partnerId,
      role: "partner",
      name: "Review Partner",
      email: "review.partner@rooms.test",
      phone: "+79000000002",
      city: "Voronezh",
      passwordHash,
      passwordResetRequired: false,
      blockedAt: null,
    },
    {
      id: adminId,
      role: "admin",
      name: "Review Admin",
      email: "review.admin@rooms.test",
      phone: "+79000000003",
      city: "Voronezh",
      passwordHash,
      passwordResetRequired: false,
      blockedAt: null,
    },
  ]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const room = demoRooms.find((item) => item.id === roomIds.kosmos)!;
  const catalogRepository = new MemoryCatalogRepository();
  const bookingRepository = new MemoryBookingRepository({
    partners: [{ userId: partnerId, venue }],
    now: () => new Date(now),
  });
  const reviewRepository = new MemoryReviewRepository(bookingRepository, catalogRepository, () => new Date(now));
  const booking = await bookingRepository.create({
    clientId,
    clientName: "Review Client",
    clientPhone: "+79000000001",
    clientEmail: "review.client@rooms.test",
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
    startsAt: "2026-07-20T08:00:00.000Z",
    endsAt: "2026-07-20T10:00:00.000Z",
    guests: 8,
    eventType: "kids",
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
    legal: { termsVersion: "test", privacyVersion: "test", acceptedAt: now.toISOString() },
    ip: null,
    userAgent: null,
  });
  await bookingRepository.confirmByPartner(partnerId, booking.id);
  bookingRepository.completePayment(clientId, booking.id);

  const app = buildApp({
    logger: false,
    authRepository,
    bookingRepository,
    repository: catalogRepository,
    reviewRepository,
  });
  await app.ready();
  const login = async (email: string) => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: email, password } });
    assert.equal(response.statusCode, 200);
    return { authorization: `Bearer ${response.json().accessToken as string}` };
  };
  const clientHeaders = await login("review.client@rooms.test");
  const partnerHeaders = await login("review.partner@rooms.test");
  const adminHeaders = await login("review.admin@rooms.test");

  const beforeCompletion = await app.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/review`,
    headers: clientHeaders,
    payload: { roomId: room.id, rating: 5, body: "The room was comfortable and clean." },
  });
  assert.equal(beforeCompletion.statusCode, 409);
  assert.equal(beforeCompletion.json().code, "REVIEW_NOT_ELIGIBLE");

  const completion = await app.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/complete`,
    headers: clientHeaders,
  });
  assert.equal(completion.statusCode, 200);
  assert.equal(completion.json().status, "completed");

  const submitted = await app.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/review`,
    headers: clientHeaders,
    payload: { roomId: room.id, rating: 5, body: "The room was comfortable and clean." },
  });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.json().status, "pending");
  const reviewId = submitted.json().id as string;

  const duplicate = await app.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/review`,
    headers: clientHeaders,
    payload: { roomId: room.id, rating: 4, body: "A second review must not be accepted." },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().code, "REVIEW_EXISTS");

  const pending = await app.inject({ method: "GET", url: "/v1/admin/reviews?status=pending", headers: adminHeaders });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().length, 1);

  const missingReason = await app.inject({
    method: "PATCH",
    url: `/v1/admin/reviews/${reviewId}`,
    headers: adminHeaders,
    payload: { status: "rejected" },
  });
  assert.equal(missingReason.statusCode, 400);
  assert.equal(missingReason.json().code, "REVIEW_COMMENT_REQUIRED");

  const rejected = await app.inject({
    method: "PATCH",
    url: `/v1/admin/reviews/${reviewId}`,
    headers: adminHeaders,
    payload: { status: "rejected", comment: "Please remove personal contact details." },
  });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json().status, "rejected");

  const resubmitted = await app.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/review`,
    headers: clientHeaders,
    payload: { roomId: room.id, rating: 4, body: "Updated review without personal contact details." },
  });
  assert.equal(resubmitted.statusCode, 201);
  assert.equal(resubmitted.json().id, reviewId);
  assert.equal(resubmitted.json().status, "pending");
  assert.equal(resubmitted.json().moderationComment, null);

  const approved = await app.inject({
    method: "PATCH",
    url: `/v1/admin/reviews/${reviewId}`,
    headers: adminHeaders,
    payload: { status: "approved" },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().status, "approved");

  const partnerReviews = await app.inject({ method: "GET", url: "/v1/partner/reviews", headers: partnerHeaders });
  assert.equal(partnerReviews.statusCode, 200);
  assert.equal(partnerReviews.json()[0].id, reviewId);

  const reply = await app.inject({
    method: "PATCH",
    url: `/v1/partner/reviews/${reviewId}/reply`,
    headers: partnerHeaders,
    payload: { body: "Thank you. We will be glad to see you again." },
  });
  assert.equal(reply.statusCode, 200);
  assert.match(reply.json().partnerReply, /Thank you/);

  const publicReviews = await app.inject({ method: "GET", url: `/v1/rooms/${room.slug}/reviews` });
  assert.equal(publicReviews.statusCode, 200);
  const published = publicReviews.json().items.find((item: { id: string }) => item.id === reviewId);
  assert.equal(published.rating, 4);
  assert.match(published.partnerReply, /Thank you/);

  const clientReviews = await app.inject({ method: "GET", url: "/v1/me/reviews", headers: clientHeaders });
  assert.equal(clientReviews.statusCode, 200);
  assert.equal(clientReviews.json()[0].status, "approved");
  await app.close();
});
