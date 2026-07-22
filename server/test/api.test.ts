import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { hashPassword, MemoryAuthRepository } from "../src/auth.js";
import { availabilityForRoom } from "../src/availability.js";
import { MemoryBookingRepository } from "../src/bookings.js";
import { demoVenues, MemoryCatalogRepository, roomIds, venueIds } from "../src/catalog.js";
import { MemoryPartnerCatalogRepository } from "../src/partnerCatalog.js";
import type { Room } from "../src/types.js";

let app: FastifyInstance;

before(async () => {
  app = buildApp({ logger: false, exposePasswordResetToken: true });
  await app.ready();
});

after(async () => {
  await app.close();
});

test("health reports the active repository", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().status, "ok");
  assert.deepEqual(response.json().storage, "memory");
  assert.deepEqual(response.json().database, "down");
});

test("local preview serves the current site and its room photography", async () => {
  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] ?? "", /text\/html/);
  assert.match(page.body, /Rooms/);
  const venuePage = await app.inject({ method: "GET", url: "/venues/kids-loft" });
  assert.equal(venuePage.statusCode, 200);
  assert.match(venuePage.headers["content-type"] ?? "", /text\/html/);
  assert.match(venuePage.body, /function venueRouteState/);
  const catalogPage = await app.inject({ method: "GET", url: "/catalog?city=%D0%92%D0%BE%D1%80%D0%BE%D0%BD%D0%B5%D0%B6&guests=12" });
  assert.equal(catalogPage.statusCode, 200);
  assert.match(catalogPage.body, /<title>Каталог помещений — Rooms<\/title>/);
  assert.match(catalogPage.body, /<link rel="canonical" href="http:\/\/localhost(?::80)?\/catalog">/);
  const partnerApplyPage = await app.inject({ method: "GET", url: "/for-partners" });
  assert.equal(partnerApplyPage.statusCode, 200);
  assert.match(partnerApplyPage.body, /<title>Добавить площадку — Rooms<\/title>/);
  assert.match(partnerApplyPage.body, /<link rel="canonical" href="http:\/\/localhost(?::80)?\/for-partners">/);
  assert.doesNotMatch(partnerApplyPage.body, /data-rooms-private="true"/);
  const accountPage = await app.inject({ method: "GET", url: "/account" });
  assert.equal(accountPage.statusCode, 200);
  assert.match(accountPage.body, /<title>Личный кабинет — Rooms<\/title>/);
  assert.match(accountPage.body, /<meta name="robots" content="noindex,nofollow" data-rooms-private="true">/);
  const partnerPage = await app.inject({ method: "GET", url: "/partner" });
  assert.equal(partnerPage.statusCode, 200);
  assert.match(partnerPage.body, /<title>Кабинет партнёра — Rooms<\/title>/);
  assert.match(partnerPage.body, /<meta name="robots" content="noindex,nofollow" data-rooms-private="true">/);
  const adminPage = await app.inject({ method: "GET", url: "/admin" });
  assert.equal(adminPage.statusCode, 200);
  assert.match(adminPage.body, /<title>Админка — Rooms<\/title>/);
  assert.match(adminPage.body, /<meta name="robots" content="noindex,nofollow" data-rooms-private="true">/);
  const accountingPage = await app.inject({ method: "GET", url: "/accounting" });
  assert.equal(accountingPage.statusCode, 200);
  assert.match(accountingPage.body, /<title>Бухгалтерия — Rooms<\/title>/);
  assert.match(accountingPage.body, /<meta name="robots" content="noindex,nofollow" data-rooms-private="true">/);
  const roomPage = await app.inject({ method: "GET", url: "/venues/kids-loft/rooms/kosmos" });
  assert.equal(roomPage.statusCode, 200);
  assert.match(roomPage.headers["content-type"] ?? "", /text\/html/);
  assert.equal(roomPage.headers["cache-control"], "no-store");
  assert.match(roomPage.body, /<base href="\/">/);
  assert.match(roomPage.body, /<meta name="rooms-routing" content="path">/);
  assert.match(roomPage.body, /<title>Комната Космос в Kids Loft — Rooms<\/title>/);
  assert.match(roomPage.body, /<meta property="og:image" content="https:\/\/amodous\.github\.io\/Rooms-bron\/assets\/kids-loft\.jpg">/);
  assert.match(roomPage.body, /<link rel="canonical" href="http:\/\/localhost(?::80)?\/venues\/kids-loft\/rooms\/kosmos">/);
  const unknownVenue = await app.inject({ method: "GET", url: "/venues/not-a-real-venue" });
  assert.equal(unknownVenue.statusCode, 404);
  assert.match(unknownVenue.headers["content-type"] ?? "", /text\/html/);
  const photo = await app.inject({ method: "GET", url: "/assets/kids-loft.jpg" });
  assert.equal(photo.statusCode, 200);
  assert.match(photo.headers["content-type"] ?? "", /image\/jpeg/);
  assert.ok(photo.rawPayload.length > 1000);
});

test("production responses include defensive headers and auth responses are not cached", async () => {
  const productionApp = buildApp({ logger: false, productionMode: true, secureCookies: true });
  await productionApp.ready();
  try {
    const health = await productionApp.inject({ method: "GET", url: "/health" });
    assert.equal(health.headers["x-content-type-options"], "nosniff");
    assert.equal(health.headers["x-frame-options"], "DENY");
    assert.equal(health.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.equal(health.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
    assert.equal(health.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");

    const login = await productionApp.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { login: "missing@rooms.test", password: "wrong-password" },
    });
    assert.equal(login.headers["cache-control"], "no-store");
    assert.equal(login.headers.pragma, "no-cache");
  } finally {
    await productionApp.close();
  }
});

test("login limiter blocks distributed guessing against the same account", async () => {
  const limiterApp = buildApp({ logger: false });
  await limiterApp.ready();
  try {
    const registration = {
      name: "Клиент лимитера",
      email: "limiter.client@rooms.test",
      phone: "+7 900 100-20-30",
      city: "Воронеж",
      password: "limiter-right-2026",
      legal: {
        termsVersion: "test-1",
        privacyVersion: "test-1",
        acceptedAt: new Date().toISOString(),
      },
    };
    const created = await limiterApp.inject({ method: "POST", url: "/v1/auth/client/register", payload: registration });
    assert.equal(created.statusCode, 201);

    const loginVariants = [registration.phone, "8 (900) 100-20-30", "79001002030", "9001002030", "+7-900-100-20-30"];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const wrong = await limiterApp.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: `198.51.100.${attempt}`,
        payload: { login: loginVariants[attempt - 1], password: `wrong-${attempt}` },
      });
      assert.equal(wrong.statusCode, 401);
    }

    const blocked = await limiterApp.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "203.0.113.10",
      payload: { login: "+7 900 100 20 30", password: registration.password },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers["retry-after"], "600");
  } finally {
    await limiterApp.close();
  }
});

test("cities include pilot Voronezh and Moscow", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/cities" });
  assert.equal(response.statusCode, 200);
  const cities = response.json();
  assert.equal(cities.find((city: { name: string }) => city.name === "Воронеж")?.pilot, true);
  assert.ok(cities.some((city: { name: string }) => city.name === "Москва"));
});

test("client auth keeps passwords private and revokes a logged-out session", async () => {
  const registration = {
    name: "Тестовый клиент",
    email: "client.auth@rooms.test",
    phone: "+7 900 111-22-33",
    city: "Воронеж",
    password: "rooms-test-2026",
    legal: {
      termsVersion: "test-1",
      privacyVersion: "test-1",
      acceptedAt: new Date().toISOString(),
    },
  };
  const created = await app.inject({ method: "POST", url: "/v1/auth/client/register", payload: registration });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().user.email, registration.email);
  assert.equal(created.json().user.phone, "+79001112233");
  assert.equal("password" in created.json().user, false);
  assert.equal("passwordHash" in created.json().user, false);
  assert.match(String(created.headers["set-cookie"]), /rooms_refresh=.*HttpOnly/);

  const duplicate = await app.inject({ method: "POST", url: "/v1/auth/client/register", payload: registration });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().code, "ACCOUNT_EXISTS");

  const wrong = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: registration.email, password: "wrong-password" },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().code, "INVALID_CREDENTIALS");

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "+7 900 111-22-33", password: registration.password },
  });
  assert.equal(login.statusCode, 200);
  const accessToken = login.json().accessToken;
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  assert.ok(accessToken);

  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().name, registration.name);

  const refresh = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie } });
  assert.equal(refresh.statusCode, 200);
  const refreshedAccessToken = refresh.json().accessToken;
  const refreshedCookie = String(refresh.headers["set-cookie"]).split(";")[0];
  assert.ok(refreshedAccessToken);
  assert.notEqual(refreshedCookie, cookie);
  const supersededAccess = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(supersededAccess.statusCode, 401);
  const replayedRefresh = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie } });
  assert.equal(replayedRefresh.statusCode, 401);

  const logout = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: { authorization: `Bearer ${refreshedAccessToken}`, cookie: refreshedCookie },
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);

  const revoked = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${refreshedAccessToken}` } });
  assert.equal(revoked.statusCode, 401);
  const expiredRefresh = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: refreshedCookie } });
  assert.equal(expiredRefresh.statusCode, 401);
  const malformedRefresh = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: "rooms_refresh=%E0%A4%A" } });
  assert.equal(malformedRefresh.statusCode, 401);
});

test("password recovery is one-time and clients can close sessions on other devices", async () => {
  const registration = {
    name: "Клиент безопасности",
    email: "security.client@rooms.test",
    phone: "+7 900 919-20-26",
    city: "Воронеж",
    password: "security-old-2026",
    legal: { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() },
  };
  const first = await app.inject({
    method: "POST",
    url: "/v1/auth/client/register",
    headers: { "user-agent": "Rooms Test Desktop" },
    payload: registration,
  });
  assert.equal(first.statusCode, 201);
  const firstAccess = first.json().accessToken;

  const second = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { "user-agent": "Rooms Test Mobile" },
    payload: { login: registration.email, password: registration.password },
  });
  assert.equal(second.statusCode, 200);
  const secondAccess = second.json().accessToken;

  const sessions = await app.inject({
    method: "GET",
    url: "/v1/me/sessions",
    headers: { authorization: `Bearer ${firstAccess}` },
  });
  assert.equal(sessions.statusCode, 200);
  assert.equal(sessions.json().items.length, 2);
  assert.equal(sessions.json().items.filter((item: { current: boolean }) => item.current).length, 1);
  assert.ok(sessions.json().items.some((item: { userAgent: string }) => item.userAgent === "Rooms Test Mobile"));

  const revokeOthers = await app.inject({
    method: "DELETE",
    url: "/v1/me/sessions/others",
    headers: { authorization: `Bearer ${firstAccess}` },
  });
  assert.equal(revokeOthers.statusCode, 204);
  const revokedSecond = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${secondAccess}` } });
  assert.equal(revokedSecond.statusCode, 401);

  const unknownRequest = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { login: "missing.account@rooms.test" },
  });
  assert.equal(unknownRequest.statusCode, 202);
  assert.equal(unknownRequest.json().accepted, true);
  assert.ok(unknownRequest.json().demoToken);

  const resetRequest = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { login: registration.email },
  });
  assert.equal(resetRequest.statusCode, 202);
  assert.equal(resetRequest.json().message, unknownRequest.json().message);
  const resetToken = resetRequest.json().demoToken;
  assert.ok(resetToken);

  const reset = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: { token: resetToken, newPassword: "security-new-2026" },
  });
  assert.equal(reset.statusCode, 204);
  const revokedFirst = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${firstAccess}` } });
  assert.equal(revokedFirst.statusCode, 401);

  const oldPassword = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: registration.email, password: registration.password },
  });
  assert.equal(oldPassword.statusCode, 401);
  const newPassword = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: registration.email, password: "security-new-2026" },
  });
  assert.equal(newPassword.statusCode, 200);

  const replay = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: { token: resetToken, newPassword: "security-replayed-2026" },
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().code, "PASSWORD_RESET_INVALID");
});

test("client profile and bookings use authenticated server data and server prices", async () => {
  const registration = {
    name: "Клиент бронирования",
    email: "booking.client@rooms.test",
    phone: "+7 900 222-33-44",
    city: "Воронеж",
    password: "booking-test-2026",
    legal: { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() },
  };
  const created = await app.inject({ method: "POST", url: "/v1/auth/client/register", payload: registration });
  assert.equal(created.statusCode, 201);
  const accessToken = created.json().accessToken;
  const otherSession = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: registration.email, password: registration.password },
  });
  assert.equal(otherSession.statusCode, 200);

  const wrongPassword = await app.inject({
    method: "PATCH",
    url: "/v1/me",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: "Обновлённый клиент",
      email: "booking.updated@rooms.test",
      phone: "+7 900 222-33-44",
      city: "Воронеж",
      currentPassword: "not-the-current-password",
      newPassword: "booking-updated-2026",
    },
  });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(wrongPassword.json().code, "CURRENT_PASSWORD_INVALID");

  const profile = await app.inject({
    method: "PATCH",
    url: "/v1/me",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: "Обновлённый клиент",
      email: "booking.updated@rooms.test",
      phone: "+7 900 222-33-44",
      city: "Воронеж",
      currentPassword: registration.password,
      newPassword: "booking-updated-2026",
    },
  });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().name, "Обновлённый клиент");
  const revokedOtherSession = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${otherSession.json().accessToken}` },
  });
  assert.equal(revokedOtherSession.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "booking.updated@rooms.test", password: "booking-updated-2026" },
  });
  assert.equal(login.statusCode, 200);
  const currentAccessToken = login.json().accessToken;
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const bookingBody = {
    primaryRoomId: roomIds.kosmos,
    roomIds: [roomIds.kosmos],
    startsAt: `${future}T10:00:00+03:00`,
    durationMinutes: 120,
    guests: 8,
    eventType: "kids",
    eventName: "День рождения",
    serviceIds: ["30000000-0000-4000-8000-000000000001"],
    onSitePaymentMethod: "card",
    comment: "Нужен стол для торта",
    legal: { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() },
  };
  const booking = await app.inject({
    method: "POST",
    url: "/v1/bookings",
    headers: { authorization: `Bearer ${currentAccessToken}` },
    payload: bookingBody,
  });
  assert.equal(booking.statusCode, 201);
  assert.equal(booking.json().status, "pending");
  assert.equal(booking.json().clientName, "Обновлённый клиент");
  assert.equal(booking.json().money.roomTotal, 3200);
  assert.equal(booking.json().money.serviceTotal, 4000);
  assert.equal(booking.json().money.total, 7200);
  assert.equal(booking.json().money.prepayment, 2160);
  assert.equal(booking.json().money.remainingOnSite, 5040);

  const list = await app.inject({
    method: "GET",
    url: "/v1/bookings?statusGroup=active",
    headers: { authorization: `Bearer ${currentAccessToken}` },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].id, booking.json().id);

  const unavailable = await app.inject({
    method: "POST",
    url: "/v1/bookings",
    headers: { authorization: `Bearer ${currentAccessToken}` },
    payload: { ...bookingBody, startsAt: `${future}T18:00:00+03:00` },
  });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().code, "SLOT_UNAVAILABLE");
});

test("partner queue holds one conflicting booking for 15 minutes and hides the client phone", async () => {
  const partnerId = "50000000-0000-4000-8000-000000000001";
  const partnerPassword = "rooms2026";
  let clock = new Date();
  const authRepository = new MemoryAuthRepository([{
    id: partnerId,
    role: "partner",
    name: "Менеджер Kids Loft",
    email: "manager@kids-loft.ru",
    phone: null,
    city: "Воронеж",
    passwordHash: await hashPassword(partnerPassword),
    passwordResetRequired: false,
    blockedAt: null,
  }]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const bookingRepository = new MemoryBookingRepository({
    partners: [{ userId: partnerId, venue }],
    now: () => new Date(clock),
  });
  const partnerApp = buildApp({ logger: false, authRepository, bookingRepository });
  await partnerApp.ready();
  const future = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const legal = { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() };
  const register = async (index: number) => {
    const response = await partnerApp.inject({
      method: "POST",
      url: "/v1/auth/client/register",
      payload: {
        name: `Клиент ${index}`,
        email: `partner-flow-${index}@rooms.test`,
        phone: `+7 901 000-00-0${index}`,
        city: "Воронеж",
        password: `partner-client-${index}-2026`,
        legal,
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const createBooking = async (accessToken: string) => {
    const response = await partnerApp.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        primaryRoomId: roomIds.kosmos,
        roomIds: [roomIds.kosmos],
        startsAt: `${future}T10:00:00+03:00`,
        durationMinutes: 120,
        guests: 6,
        eventType: "kids",
        onSitePaymentMethod: "card",
        legal,
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json();
  };
  const firstClientToken = await register(1);
  const secondClientToken = await register(2);
  const first = await createBooking(firstClientToken);
  const second = await createBooking(secondClientToken);
  const login = await partnerApp.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "manager@kids-loft.ru", password: partnerPassword },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.role, "partner");
  const partnerToken = login.json().accessToken as string;
  const partnerHeaders = { authorization: `Bearer ${partnerToken}` };

  const assignedVenue = await partnerApp.inject({ method: "GET", url: "/v1/partner/venue", headers: partnerHeaders });
  assert.equal(assignedVenue.statusCode, 200);
  assert.equal(assignedVenue.json().id, venueIds.kidsLoft);
  const queue = await partnerApp.inject({ method: "GET", url: "/v1/partner/bookings?statusGroup=new", headers: partnerHeaders });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.json().length, 2);
  assert.equal(queue.json()[0].clientPhone, null);
  assert.equal(queue.json()[0].clientEmail, null);

  const confirmed = await partnerApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${first.id}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().status, "awaiting_payment");
  assert.equal(confirmed.json().clientPhone, null);
  assert.equal(confirmed.json().clientEmail, null);
  assert.ok(new Date(confirmed.json().paymentHoldExpiresAt).getTime() > clock.getTime());

  const conflict = await partnerApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${second.id}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "SLOT_CONFLICT");
  const rejected = await partnerApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${second.id}/reject`,
    headers: partnerHeaders,
    payload: { reason: "Время больше недоступно" },
  });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json().status, "cancelled");

  clock = new Date(clock.getTime() + 16 * 60_000);
  const expired = await partnerApp.inject({
    method: "GET",
    url: "/v1/bookings?statusGroup=cancelled",
    headers: { authorization: `Bearer ${firstClientToken}` },
  });
  assert.equal(expired.statusCode, 200);
  assert.equal(expired.json()[0].status, "expired");
  assert.equal(expired.json()[0].paymentHoldExpiresAt, null);

  const third = await createBooking(firstClientToken);
  const confirmedAfterExpiry = await partnerApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${third.id}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(confirmedAfterExpiry.statusCode, 200);
  assert.equal(confirmedAfterExpiry.json().status, "awaiting_payment");
  await partnerApp.close();
});

test("partner catalog persists operational settings and keeps public edits in moderation", async () => {
  const partnerId = "50000000-0000-4000-8000-000000000021";
  const partnerPassword = "rooms2026";
  const adminId = "50000000-0000-4000-8000-000000000022";
  const adminPassword = "admin-rooms-2026";
  const authRepository = new MemoryAuthRepository([
    {
      id: partnerId,
      role: "partner",
      name: "Редактор Kids Loft",
      email: "catalog@kids-loft.ru",
      phone: null,
      city: "Воронеж",
      passwordHash: await hashPassword(partnerPassword),
      passwordResetRequired: false,
      blockedAt: null,
    },
    {
      id: adminId,
      role: "admin",
      name: "Администратор Rooms",
      email: "admin.catalog@rooms.test",
      phone: null,
      city: "Воронеж",
      passwordHash: await hashPassword(adminPassword),
      passwordResetRequired: false,
      blockedAt: null,
    },
  ]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const bookingRepository = new MemoryBookingRepository({ partners: [{ userId: partnerId, venue }] });
  const partnerCatalogRepository = new MemoryPartnerCatalogRepository();
  const catalogApp = buildApp({ logger: false, authRepository, bookingRepository, partnerCatalogRepository });
  await catalogApp.ready();
  const login = await catalogApp.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "catalog@kids-loft.ru", password: partnerPassword },
  });
  assert.equal(login.statusCode, 200);
  const headers = { authorization: `Bearer ${login.json().accessToken as string}` };
  const unauthenticated = await catalogApp.inject({ method: "GET", url: "/v1/partner/rooms" });
  assert.equal(unauthenticated.statusCode, 401);

  const weekSchedule = Array.from({ length: 7 }, (_, index) => ({
    weekday: index + 1,
    enabled: index !== 0,
    opensAtHour: 10,
    closesAtHour: index >= 4 ? 26 : 24,
  }));
  const venueUpdate = await catalogApp.inject({
    method: "PATCH",
    url: "/v1/partner/venue",
    headers,
    payload: {
      title: "Kids Loft на Маркса",
      city: "Воронеж",
      address: venue.address,
      venueType: "Детский лофт",
      description: venue.description,
      rules: venue.rules,
      contactName: "Марина",
      contactPhone: "+7 900 123-45-67",
      contactEmail: "catalog@kids-loft.ru",
      amenities: venue.amenities,
      paymentMethods: ["card", "cash"],
      weekSchedule,
    },
  });
  assert.equal(venueUpdate.statusCode, 202);
  assert.equal(venueUpdate.json().title, "Kids Loft");
  assert.equal(venueUpdate.json().contactName, "Марина");
  assert.equal(venueUpdate.json().weekSchedule[0].enabled, false);
  assert.equal(venueUpdate.json().pendingChange.proposedData.title, "Kids Loft на Маркса");

  const roomsBefore = await catalogApp.inject({ method: "GET", url: "/v1/partner/rooms", headers });
  assert.equal(roomsBefore.statusCode, 200);
  assert.equal(roomsBefore.json().length, 2);
  const kosmos = roomsBefore.json().find((item: { id: string }) => item.id === roomIds.kosmos);
  const roomUpdate = await catalogApp.inject({
    method: "PATCH",
    url: `/v1/partner/rooms/${roomIds.kosmos}`,
    headers,
    payload: {
      title: "Космос Premium",
      subtitle: kosmos.subtitle,
      type: kosmos.type,
      description: kosmos.description,
      rules: kosmos.rules,
      promotion: kosmos.promotion ?? "",
      capacityMin: kosmos.capacityMin,
      capacityMax: 16,
      pricePerHour: 1900,
      minimumHours: 3,
      bufferMinutes: 30,
      opensAtHour: 11,
      closesAtHour: 25,
      features: kosmos.features,
      tags: kosmos.tags,
      services: kosmos.services,
      status: "published",
    },
  });
  assert.equal(roomUpdate.statusCode, 200);
  assert.equal(roomUpdate.json().title, "Комната Космос");
  assert.equal(roomUpdate.json().minimumHours, 3);
  assert.equal(roomUpdate.json().bufferMinutes, 30);
  assert.equal(roomUpdate.json().pendingChange.proposedData.title, "Космос Premium");

  const exception = await catalogApp.inject({
    method: "PUT",
    url: "/v1/partner/schedule-exceptions/2026-08-15",
    headers,
    payload: { mode: "custom", opensAtHour: 12, closesAtHour: 22, note: "Сокращённый день" },
  });
  assert.equal(exception.statusCode, 200);
  assert.deepEqual(exception.json().scheduleExceptions[0], {
    date: "2026-08-15",
    mode: "custom",
    opensAtHour: 12,
    closesAtHour: 22,
    note: "Сокращённый день",
  });
  const resetException = await catalogApp.inject({
    method: "DELETE",
    url: "/v1/partner/schedule-exceptions/2026-08-15",
    headers,
  });
  assert.equal(resetException.statusCode, 200);
  assert.equal(resetException.json().scheduleExceptions.length, 0);

  const createdRoom = await catalogApp.inject({
    method: "POST",
    url: "/v1/partner/rooms",
    headers,
    payload: {
      title: "Творческая студия",
      subtitle: "Детская комната",
      type: "kids",
      description: "Отдельное светлое помещение для мастер-классов и праздников.",
      rules: "Еду и декор нужно согласовать заранее.",
      promotion: "",
      capacityMin: 1,
      capacityMax: 12,
      pricePerHour: 1700,
      minimumHours: 2,
      bufferMinutes: 15,
      opensAtHour: 10,
      closesAtHour: 23,
      features: ["kids", "food"],
      tags: ["мастер-класс"],
      services: [{ name: "Аниматор", description: "Программа на один час", price: 2500 }],
      status: "review",
    },
  });
  assert.equal(createdRoom.statusCode, 202);
  assert.equal(createdRoom.json().publicationStatus, "review");
  assert.match(createdRoom.json().services[0].id, /^[0-9a-f-]{36}$/u);
  assert.equal(createdRoom.json().pendingChange.proposedData.publicationRequested, true);
  const roomsAfter = await catalogApp.inject({ method: "GET", url: "/v1/partner/rooms", headers });
  assert.equal(roomsAfter.json().length, 3);

  const wrongVenueRoom = await catalogApp.inject({
    method: "PATCH",
    url: `/v1/partner/rooms/${roomIds.voiceVip}`,
    headers,
    payload: {
      title: "Чужая комната",
      subtitle: "Караоке",
      type: "karaoke",
      description: "Эта комната принадлежит другой площадке и не должна измениться.",
      rules: "Правила другой площадки.",
      promotion: "",
      capacityMin: 1,
      capacityMax: 8,
      pricePerHour: 2000,
      minimumHours: 2,
      bufferMinutes: 0,
      opensAtHour: 10,
      closesAtHour: 24,
      features: ["karaoke"],
      tags: ["караоке"],
      services: [],
      status: "published",
    },
  });
  assert.equal(wrongVenueRoom.statusCode, 404);

  const partnerCannotModerate = await catalogApp.inject({ method: "GET", url: "/v1/admin/moderation", headers });
  assert.equal(partnerCannotModerate.statusCode, 403);
  const adminLogin = await catalogApp.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "admin.catalog@rooms.test", password: adminPassword },
  });
  assert.equal(adminLogin.statusCode, 200);
  assert.equal(adminLogin.json().user.role, "admin");
  const adminHeaders = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };
  const moderation = await catalogApp.inject({
    method: "GET",
    url: "/v1/admin/moderation?status=pending&limit=20",
    headers: adminHeaders,
  });
  assert.equal(moderation.statusCode, 200);
  assert.equal(moderation.json().length, 3);
  const venueModeration = moderation.json().find((item: { targetType: string }) => item.targetType === "venue");
  const existingRoomModeration = moderation.json().find((item: { targetId: string }) => item.targetId === roomIds.kosmos);
  const newRoomModeration = moderation.json().find((item: { targetId: string }) => item.targetId === createdRoom.json().id);
  assert.ok(venueModeration);
  assert.ok(existingRoomModeration);
  assert.ok(newRoomModeration);

  const approvedVenue = await catalogApp.inject({
    method: "POST",
    url: `/v1/admin/moderation/${venueModeration.id}/approve`,
    headers: adminHeaders,
    payload: { comment: "Данные площадки проверены" },
  });
  assert.equal(approvedVenue.statusCode, 200);
  assert.equal(approvedVenue.json().status, "approved");
  const venueAfterApproval = await catalogApp.inject({ method: "GET", url: "/v1/partner/venue", headers });
  assert.equal(venueAfterApproval.json().title, "Kids Loft на Маркса");
  assert.equal(venueAfterApproval.json().pendingChange, null);

  const approvedRoom = await catalogApp.inject({
    method: "POST",
    url: `/v1/admin/moderation/${existingRoomModeration.id}/approve`,
    headers: adminHeaders,
    payload: { comment: "Карточка соответствует правилам" },
  });
  assert.equal(approvedRoom.statusCode, 200);
  const roomsAfterApproval = await catalogApp.inject({ method: "GET", url: "/v1/partner/rooms", headers });
  const approvedKosmos = roomsAfterApproval.json().find((item: { id: string }) => item.id === roomIds.kosmos);
  assert.equal(approvedKosmos.title, "Космос Premium");
  assert.equal(approvedKosmos.pricePerHour, 1900);
  assert.equal(approvedKosmos.pendingChange, null);

  const rejectWithoutReason = await catalogApp.inject({
    method: "POST",
    url: `/v1/admin/moderation/${newRoomModeration.id}/reject`,
    headers: adminHeaders,
    payload: { comment: "" },
  });
  assert.equal(rejectWithoutReason.statusCode, 400);
  const rejectedRoom = await catalogApp.inject({
    method: "POST",
    url: `/v1/admin/moderation/${newRoomModeration.id}/reject`,
    headers: adminHeaders,
    payload: { comment: "Нужно дополнить описание помещения" },
  });
  assert.equal(rejectedRoom.statusCode, 200);
  assert.equal(rejectedRoom.json().status, "rejected");
  assert.equal(rejectedRoom.json().reviewComment, "Нужно дополнить описание помещения");
  const roomsAfterRejection = await catalogApp.inject({ method: "GET", url: "/v1/partner/rooms", headers });
  const hiddenRoom = roomsAfterRejection.json().find((item: { id: string }) => item.id === createdRoom.json().id);
  assert.equal(hiddenRoom.publicationStatus, "hidden");
  assert.equal(hiddenRoom.pendingChange, null);
  const partnerModerationHistory = await catalogApp.inject({ method: "GET", url: "/v1/partner/moderation", headers });
  assert.equal(partnerModerationHistory.statusCode, 200);
  assert.equal(partnerModerationHistory.json().length, 3);
  assert.ok(partnerModerationHistory.json().some((item: { status: string }) => item.status === "approved"));
  assert.ok(partnerModerationHistory.json().some((item: { status: string; reviewComment: string }) => (
    item.status === "rejected" && item.reviewComment === "Нужно дополнить описание помещения"
  )));
  const repeatedDecision = await catalogApp.inject({
    method: "POST",
    url: `/v1/admin/moderation/${newRoomModeration.id}/approve`,
    headers: adminHeaders,
    payload: { comment: "Повторная попытка" },
  });
  assert.equal(repeatedDecision.statusCode, 409);
  assert.equal(repeatedDecision.json().code, "MODERATION_ALREADY_REVIEWED");
  await catalogApp.close();
});

test("booking conversation persists messages and lets the client accept a partner time proposal", async () => {
  const partnerId = "50000000-0000-4000-8000-000000000031";
  const partnerPassword = "rooms2026";
  const authRepository = new MemoryAuthRepository([{
    id: partnerId,
    role: "partner",
    name: "Менеджер согласований",
    email: "conversation@kids-loft.ru",
    phone: null,
    city: "Воронеж",
    passwordHash: await hashPassword(partnerPassword),
    passwordResetRequired: false,
    blockedAt: null,
  }]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const bookingRepository = new MemoryBookingRepository({ partners: [{ userId: partnerId, venue }] });
  const conversationApp = buildApp({ logger: false, authRepository, bookingRepository });
  await conversationApp.ready();
  const legal = { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() };
  const future = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const clientRegistration = await conversationApp.inject({
    method: "POST",
    url: "/v1/auth/client/register",
    payload: {
      name: "Клиент согласования",
      email: "conversation-client@rooms.test",
      phone: "+7 904 000-00-01",
      city: "Воронеж",
      password: "conversation-client-2026",
      legal,
    },
  });
  assert.equal(clientRegistration.statusCode, 201);
  const clientToken = clientRegistration.json().accessToken as string;
  const clientHeaders = { authorization: `Bearer ${clientToken}` };
  const created = await conversationApp.inject({
    method: "POST",
    url: "/v1/bookings",
    headers: clientHeaders,
    payload: {
      primaryRoomId: roomIds.kosmos,
      roomIds: [roomIds.kosmos],
      startsAt: `${future}T10:00:00+03:00`,
      durationMinutes: 120,
      guests: 6,
      eventType: "kids",
      onSitePaymentMethod: "card",
      legal,
    },
  });
  assert.equal(created.statusCode, 201);
  const bookingId = created.json().id as string;
  const partnerLogin = await conversationApp.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "conversation@kids-loft.ru", password: partnerPassword },
  });
  assert.equal(partnerLogin.statusCode, 200);
  const partnerHeaders = { authorization: `Bearer ${partnerLogin.json().accessToken}` };

  const unavailableProposal = await conversationApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${bookingId}/proposal`,
    headers: partnerHeaders,
    payload: { startsAt: `${future}T18:00:00+03:00`, durationMinutes: 120, comment: "Проверка занятого окна" },
  });
  assert.equal(unavailableProposal.statusCode, 409);
  assert.equal(unavailableProposal.json().code, "SLOT_UNAVAILABLE");

  const proposed = await conversationApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${bookingId}/proposal`,
    headers: partnerHeaders,
    payload: { startsAt: `${future}T14:00:00+03:00`, durationMinutes: 180, comment: "Можем принять вас после обеда." },
  });
  assert.equal(proposed.statusCode, 200);
  assert.equal(proposed.json().status, "proposed");
  assert.equal(proposed.json().proposal.durationMinutes, 180);
  assert.equal(proposed.json().proposal.money.total, 4800);
  assert.equal(proposed.json().proposal.money.prepayment, 1440);
  const proposalId = proposed.json().proposal.id as string;

  const directConfirmation = await conversationApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${bookingId}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(directConfirmation.statusCode, 409);
  assert.equal(directConfirmation.json().code, "BOOKING_STATE_CHANGED");

  const clientMessage = await conversationApp.inject({
    method: "POST",
    url: `/v1/bookings/${bookingId}/messages`,
    headers: clientHeaders,
    payload: { body: "Подскажите, стол для торта останется доступен?" },
  });
  assert.equal(clientMessage.statusCode, 201);
  assert.deepEqual(clientMessage.json().readBy, ["client"]);
  const partnerQueue = await conversationApp.inject({
    method: "GET",
    url: "/v1/partner/bookings?statusGroup=new",
    headers: partnerHeaders,
  });
  assert.equal(partnerQueue.json()[0].unreadMessages, 1);
  const partnerMessages = await conversationApp.inject({
    method: "GET",
    url: `/v1/bookings/${bookingId}/messages`,
    headers: partnerHeaders,
  });
  assert.equal(partnerMessages.statusCode, 200);
  assert.deepEqual(partnerMessages.json()[0].readBy.sort(), ["client", "partner"]);

  const blockedContact = await conversationApp.inject({
    method: "POST",
    url: `/v1/bookings/${bookingId}/messages`,
    headers: clientHeaders,
    payload: { body: "Позвоните мне: +7 904 000-00-01" },
  });
  assert.equal(blockedContact.statusCode, 422);
  assert.equal(blockedContact.json().code, "CONTACT_DETAILS_BLOCKED");
  const partnerReply = await conversationApp.inject({
    method: "POST",
    url: `/v1/bookings/${bookingId}/messages`,
    headers: partnerHeaders,
    payload: { body: "Да, стол и выбранные услуги сохраняются." },
  });
  assert.equal(partnerReply.statusCode, 201);
  const clientList = await conversationApp.inject({
    method: "GET",
    url: "/v1/bookings?statusGroup=active",
    headers: clientHeaders,
  });
  assert.equal(clientList.statusCode, 200);
  assert.equal(clientList.json()[0].unreadMessages, 1);
  assert.equal(clientList.json()[0].proposal.id, proposalId);

  const accepted = await conversationApp.inject({
    method: "POST",
    url: `/v1/bookings/${bookingId}/proposal/accept`,
    headers: clientHeaders,
    payload: { proposalId },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().status, "awaiting_payment");
  assert.equal(accepted.json().startsAt, new Date(`${future}T14:00:00+03:00`).toISOString());
  assert.equal(accepted.json().money.total, 4800);
  assert.equal(accepted.json().money.remainingOnSite, 3360);
  assert.equal(accepted.json().proposal, null);
  assert.ok(new Date(accepted.json().paymentHoldExpiresAt).getTime() > Date.now());
  const staleAcceptance = await conversationApp.inject({
    method: "POST",
    url: `/v1/bookings/${bookingId}/proposal/accept`,
    headers: clientHeaders,
    payload: { proposalId },
  });
  assert.equal(staleAcceptance.statusCode, 409);
  assert.equal(staleAcceptance.json().code, "PROPOSAL_STALE");
  await conversationApp.close();
});

test("server prepayment finalizes the hold, is idempotent and reveals contacts to the partner", async () => {
  const partnerId = "50000000-0000-4000-8000-000000000011";
  const partnerPassword = "rooms2026";
  let clock = new Date();
  const authRepository = new MemoryAuthRepository([{
    id: partnerId,
    role: "partner",
    name: "Менеджер Kids Loft",
    email: "payments@kids-loft.ru",
    phone: null,
    city: "Воронеж",
    passwordHash: await hashPassword(partnerPassword),
    passwordResetRequired: false,
    blockedAt: null,
  }]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const bookingRepository = new MemoryBookingRepository({
    partners: [{ userId: partnerId, venue }],
    now: () => new Date(clock),
  });
  const paymentApp = buildApp({ logger: false, authRepository, bookingRepository, enableDemoPayments: true });
  await paymentApp.ready();
  const legal = { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() };
  const register = async (index: number) => {
    const response = await paymentApp.inject({
      method: "POST",
      url: "/v1/auth/client/register",
      payload: {
        name: `Плательщик ${index}`,
        email: `payment-client-${index}@rooms.test`,
        phone: `+7 902 000-00-0${index}`,
        city: "Воронеж",
        password: `payment-client-${index}-2026`,
        legal,
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const firstClientToken = await register(1);
  const otherClientToken = await register(2);
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const createBooking = async (time: string) => {
    const response = await paymentApp.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: { authorization: `Bearer ${firstClientToken}` },
      payload: {
        primaryRoomId: roomIds.kosmos,
        roomIds: [roomIds.kosmos],
        startsAt: `${future}T${time}:00+03:00`,
        durationMinutes: 120,
        guests: 8,
        eventType: "kids",
        onSitePaymentMethod: "card",
        legal,
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json();
  };
  const partnerLogin = await paymentApp.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "payments@kids-loft.ru", password: partnerPassword },
  });
  assert.equal(partnerLogin.statusCode, 200);
  const partnerHeaders = { authorization: `Bearer ${partnerLogin.json().accessToken}` };
  const booking = await createBooking("10:00");
  const confirmed = await paymentApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${booking.id}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(confirmed.statusCode, 200);
  const intent = await paymentApp.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/payment-intent`,
    headers: { authorization: `Bearer ${firstClientToken}` },
    payload: { amount: 1 },
  });
  assert.equal(intent.statusCode, 201);
  assert.equal(intent.json().amount, 960);
  assert.equal(intent.json().status, "pending");
  const repeatedIntent = await paymentApp.inject({
    method: "POST",
    url: `/v1/bookings/${booking.id}/payment-intent`,
    headers: { authorization: `Bearer ${firstClientToken}` },
  });
  assert.equal(repeatedIntent.statusCode, 201);
  assert.equal(repeatedIntent.json().paymentId, intent.json().paymentId);
  const otherClientAttempt = await paymentApp.inject({
    method: "POST",
    url: `/v1/payments/${intent.json().paymentId}/demo-complete`,
    headers: { authorization: `Bearer ${otherClientToken}` },
  });
  assert.equal(otherClientAttempt.statusCode, 404);
  const paid = await paymentApp.inject({
    method: "POST",
    url: `/v1/payments/${intent.json().paymentId}/demo-complete`,
    headers: { authorization: `Bearer ${firstClientToken}` },
  });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.json().payment.status, "paid");
  assert.equal(paid.json().booking.status, "paid");
  assert.equal(paid.json().booking.paymentHoldExpiresAt, null);
  assert.match(paid.json().payment.maskedCard, /4242/);
  const repeatedPayment = await paymentApp.inject({
    method: "POST",
    url: `/v1/payments/${intent.json().paymentId}/demo-complete`,
    headers: { authorization: `Bearer ${firstClientToken}` },
  });
  assert.equal(repeatedPayment.statusCode, 200);
  assert.equal(repeatedPayment.json().payment.receiptNumber, paid.json().payment.receiptNumber);
  const partnerBooked = await paymentApp.inject({
    method: "GET",
    url: "/v1/partner/bookings?statusGroup=booked",
    headers: partnerHeaders,
  });
  assert.equal(partnerBooked.statusCode, 200);
  assert.equal(partnerBooked.json()[0].clientPhone, "+79020000001");
  assert.equal(partnerBooked.json()[0].clientEmail, "payment-client-1@rooms.test");

  const expiringBooking = await createBooking("14:00");
  const expiringConfirmation = await paymentApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${expiringBooking.id}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(expiringConfirmation.statusCode, 200);
  const expiringIntent = await paymentApp.inject({
    method: "POST",
    url: `/v1/bookings/${expiringBooking.id}/payment-intent`,
    headers: { authorization: `Bearer ${firstClientToken}` },
  });
  assert.equal(expiringIntent.statusCode, 201);
  clock = new Date(clock.getTime() + 16 * 60_000);
  const expiredPayment = await paymentApp.inject({
    method: "POST",
    url: `/v1/payments/${expiringIntent.json().paymentId}/demo-complete`,
    headers: { authorization: `Bearer ${firstClientToken}` },
  });
  assert.equal(expiredPayment.statusCode, 409);
  assert.equal(expiredPayment.json().code, "PAYMENT_HOLD_EXPIRED");
  await paymentApp.close();
});

test("partner manual reservations share availability with Rooms bookings", async () => {
  const partnerId = "50000000-0000-4000-8000-000000000021";
  const partnerPassword = "rooms2026";
  const authRepository = new MemoryAuthRepository([{
    id: partnerId,
    role: "partner",
    name: "Менеджер календаря",
    email: "calendar@kids-loft.ru",
    phone: null,
    city: "Воронеж",
    passwordHash: await hashPassword(partnerPassword),
    passwordResetRequired: false,
    blockedAt: null,
  }]);
  const venue = demoVenues.find((item) => item.id === venueIds.kidsLoft)!;
  const bookingRepository = new MemoryBookingRepository({ partners: [{ userId: partnerId, venue }] });
  const calendarApp = buildApp({ logger: false, authRepository, bookingRepository });
  await calendarApp.ready();
  const future = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const legal = { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() };
  const clientRegistration = await calendarApp.inject({
    method: "POST",
    url: "/v1/auth/client/register",
    payload: {
      name: "Клиент календаря",
      email: "calendar-client@rooms.test",
      phone: "+7 903 000-00-01",
      city: "Воронеж",
      password: "calendar-client-2026",
      legal,
    },
  });
  assert.equal(clientRegistration.statusCode, 201);
  const clientToken = clientRegistration.json().accessToken as string;
  const clientBooking = await calendarApp.inject({
    method: "POST",
    url: "/v1/bookings",
    headers: { authorization: `Bearer ${clientToken}` },
    payload: {
      primaryRoomId: roomIds.kosmos,
      roomIds: [roomIds.kosmos],
      startsAt: `${future}T10:00:00+03:00`,
      durationMinutes: 120,
      guests: 7,
      eventType: "kids",
      onSitePaymentMethod: "card",
      legal,
    },
  });
  assert.equal(clientBooking.statusCode, 201);
  const partnerLogin = await calendarApp.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { login: "calendar@kids-loft.ru", password: partnerPassword },
  });
  assert.equal(partnerLogin.statusCode, 200);
  const partnerHeaders = { authorization: `Bearer ${partnerLogin.json().accessToken}` };
  const catalogConflict = await calendarApp.inject({
    method: "POST",
    url: "/v1/partner/reservations",
    headers: partnerHeaders,
    payload: {
      roomId: roomIds.kosmos,
      type: "technical",
      category: "service",
      startsAt: `${future}T18:00:00+03:00`,
      endsAt: `${future}T19:00:00+03:00`,
      comment: "Нельзя закрыть уже занятый интервал",
    },
  });
  assert.equal(catalogConflict.statusCode, 409);
  assert.equal(catalogConflict.json().code, "SLOT_CONFLICT");
  const manual = await calendarApp.inject({
    method: "POST",
    url: "/v1/partner/reservations",
    headers: partnerHeaders,
    payload: {
      roomId: roomIds.kosmos,
      type: "manual_booking",
      startsAt: `${future}T10:00:00+03:00`,
      endsAt: `${future}T12:00:00+03:00`,
      clientName: "Мария",
      clientPhone: "+7 903 111-22-33",
      guests: 6,
      amount: 5000,
      source: "phone",
      comment: "День рождения по звонку",
    },
  });
  assert.equal(manual.statusCode, 201);
  assert.equal(manual.json().status, "active");
  assert.equal(manual.json().clientPhone, "+79031112233");
  const reservationId = manual.json().id as string;
  const typeChange = await calendarApp.inject({
    method: "PATCH",
    url: `/v1/partner/reservations/${reservationId}`,
    headers: partnerHeaders,
    payload: {
      roomId: roomIds.kosmos,
      type: "technical",
      category: "private",
      startsAt: `${future}T10:00:00+03:00`,
      endsAt: `${future}T12:00:00+03:00`,
      comment: "Тип ручной брони должен сохраниться",
    },
  });
  assert.equal(typeChange.statusCode, 409);
  assert.equal(typeChange.json().code, "RESERVATION_TYPE_IMMUTABLE");
  const list = await calendarApp.inject({
    method: "GET",
    url: `/v1/partner/reservations?dateFrom=${future}&dateTo=${future}&includeCancelled=true`,
    headers: partnerHeaders,
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  const hiddenWindow = await calendarApp.inject({
    method: "POST",
    url: "/v1/availability/search",
    payload: { roomIds: [roomIds.kosmos], date: future, durationMinutes: 120, preferredTime: "10:00", guests: 6 },
  });
  assert.equal(hiddenWindow.statusCode, 200);
  assert.equal(hiddenWindow.json().windows.some((window: { exactMatch: boolean }) => window.exactMatch), false);
  const confirmConflict = await calendarApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${clientBooking.json().id}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(confirmConflict.statusCode, 409);
  assert.equal(confirmConflict.json().code, "SLOT_CONFLICT");
  const deleteManual = await calendarApp.inject({
    method: "DELETE",
    url: `/v1/partner/reservations/${reservationId}`,
    headers: partnerHeaders,
  });
  assert.equal(deleteManual.statusCode, 409);
  assert.equal(deleteManual.json().code, "RESERVATION_CANCEL_REQUIRED");
  const cancelled = await calendarApp.inject({
    method: "POST",
    url: `/v1/partner/reservations/${reservationId}/cancel`,
    headers: partnerHeaders,
    payload: { reason: "Клиент отменил мероприятие" },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, "cancelled");
  const confirmed = await calendarApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${clientBooking.json().id}/confirm`,
    headers: partnerHeaders,
  });
  assert.equal(confirmed.statusCode, 200);
  const restoreConflict = await calendarApp.inject({
    method: "POST",
    url: `/v1/partner/reservations/${reservationId}/restore`,
    headers: partnerHeaders,
  });
  assert.equal(restoreConflict.statusCode, 409);
  assert.equal(restoreConflict.json().code, "SLOT_CONFLICT");
  const rejected = await calendarApp.inject({
    method: "POST",
    url: `/v1/partner/bookings/${clientBooking.json().id}/reject`,
    headers: partnerHeaders,
    payload: { reason: "Освобождаем интервал для ручной брони" },
  });
  assert.equal(rejected.statusCode, 200);
  const restored = await calendarApp.inject({
    method: "POST",
    url: `/v1/partner/reservations/${reservationId}/restore`,
    headers: partnerHeaders,
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().status, "active");
  const moved = await calendarApp.inject({
    method: "PATCH",
    url: `/v1/partner/reservations/${reservationId}`,
    headers: partnerHeaders,
    payload: {
      roomId: roomIds.kosmos,
      type: "manual_booking",
      startsAt: `${future}T14:00:00+03:00`,
      endsAt: `${future}T16:00:00+03:00`,
      clientName: "Мария",
      clientPhone: "+7 903 111-22-33",
      guests: 6,
      amount: 5500,
      source: "whatsapp",
      comment: "Перенесли по просьбе клиента",
    },
  });
  assert.equal(moved.statusCode, 200);
  assert.match(moved.json().startsAt, /T11:00:00\.000Z$/);
  const technical = await calendarApp.inject({
    method: "POST",
    url: "/v1/partner/reservations",
    headers: partnerHeaders,
    payload: {
      roomId: roomIds.kosmos,
      type: "technical",
      category: "service",
      startsAt: `${future}T16:00:00+03:00`,
      endsAt: `${future}T17:00:00+03:00`,
      comment: "Уборка после праздника",
    },
  });
  assert.equal(technical.statusCode, 201);
  const deletedTechnical = await calendarApp.inject({
    method: "DELETE",
    url: `/v1/partner/reservations/${technical.json().id}`,
    headers: partnerHeaders,
  });
  assert.equal(deletedTechnical.statusCode, 204);
  await calendarApp.close();
});

test("city stats expose exact supply and bucket the public audience", async () => {
  const launching = await app.inject({ method: "GET", url: "/v1/cities/воронеж/stats" });
  assert.equal(launching.statusCode, 200);
  assert.equal(launching.json().publishedVenues, 3);
  assert.equal(launching.json().publishedRooms, 5);
  assert.equal(launching.json().activeClientsLabel, null);
  assert.equal(launching.json().audienceStage, "launching");

  const audienceApp = buildApp({ logger: false, repository: new MemoryCatalogRepository({ Воронеж: 137 }) });
  const established = await audienceApp.inject({ method: "GET", url: "/v1/cities/воронеж/stats" });
  assert.equal(established.statusCode, 200);
  assert.equal(established.json().activeClientsLabel, "100+");
  assert.equal(established.json().audienceStage, "established");
  await audienceApp.close();
});

test("city stats reject unsupported cities", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/cities/unknown-city/stats" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, "CITY_NOT_FOUND");
});

test("room search requires a city", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/rooms" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "VALIDATION_ERROR");
  assert.ok(response.json().requestId);
});

test("room search keeps cities isolated and sorts by rating", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/rooms?city=Воронеж" });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.items.length, 5);
  assert.ok(payload.items.every((room: { venue: { city: string } }) => room.venue.city === "Воронеж"));
  assert.equal(payload.items[0].slug, "kosmos");
  assert.equal(payload.hasMore, false);
});

test("room search applies capacity, type, feature and price filters", async () => {
  const capacity = await app.inject({ method: "GET", url: "/v1/rooms?city=Воронеж&guests=20" });
  assert.deepEqual(capacity.json().items.map((room: { slug: string }) => room.slug), ["terrace-hall"]);

  const type = await app.inject({ method: "GET", url: "/v1/rooms?city=Воронеж&type=karaoke" });
  assert.deepEqual(type.json().items.map((room: { slug: string }) => room.slug), ["voice-small"]);

  const features = await app.inject({ method: "GET", url: "/v1/rooms?city=Воронеж&features=parking,food" });
  assert.deepEqual(features.json().items.map((room: { slug: string }) => room.slug), ["kosmos", "terrace-hall"]);

  const price = await app.inject({ method: "GET", url: "/v1/rooms?city=Воронеж&maxPricePerHour=1500" });
  assert.deepEqual(price.json().items.map((room: { slug: string }) => room.slug), ["safari"]);
});

test("time search rejects missing and impossible dates", async () => {
  const missingDate = await app.inject({ method: "GET", url: "/v1/rooms?city=Воронеж&time=12:00" });
  assert.equal(missingDate.statusCode, 400);
  assert.equal(missingDate.json().code, "DATE_REQUIRED");

  const impossibleDate = await app.inject({ method: "GET", url: "/v1/rooms?city=Воронеж&date=2026-02-30" });
  assert.equal(impossibleDate.statusCode, 400);
  assert.equal(impossibleDate.json().code, "INVALID_DATE");
});

test("time search excludes busy rooms and puts the requested start first", async () => {
  const busy = await app.inject({
    method: "GET",
    url: "/v1/rooms?city=Воронеж&type=kids&date=2026-07-18&time=18:00&durationMinutes=120",
  });
  assert.equal(busy.statusCode, 200);
  assert.deepEqual(busy.json().items, []);

  const free = await app.inject({
    method: "GET",
    url: "/v1/rooms?city=Воронеж&type=kids&date=2026-07-18&time=20:00&durationMinutes=120",
  });
  assert.equal(free.statusCode, 200);
  assert.deepEqual(free.json().items.map((room: { slug: string }) => room.slug), ["kosmos", "safari"]);
  assert.ok(free.json().items.every((room: { nearestWindows: Array<{ startsAt: string; exactMatch: boolean }> }) => (
    room.nearestWindows[0]?.startsAt.includes("T20:00:00") && room.nearestWindows[0]?.exactMatch
  )));
});

test("room detail accepts a legacy slug and exposes services and windows", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/rooms/kosmos?date=2026-07-18" });
  assert.equal(response.statusCode, 200);
  const room = response.json();
  assert.equal(room.id, roomIds.kosmos);
  assert.equal(room.venue.slug, "kids-loft");
  assert.equal(room.services.length, 2);
  assert.ok(room.availability.windows.length > 0);
  assert.ok(room.photos.every((photo: string) => photo.startsWith("https://amodous.github.io/Rooms-bron/assets/")));
});

test("room detail returns a stable not-found error", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/rooms/unknown-room" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, "ROOM_NOT_FOUND");
});

test("room reviews expose approved public feedback without client contacts", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/rooms/kosmos/reviews" });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].authorName, "Марина");
  assert.equal(payload.items[0].rating, 5);
  assert.equal(payload.hasMore, false);
  assert.equal("phone" in payload.items[0], false);
  assert.equal("email" in payload.items[0], false);
  assert.equal("clientId" in payload.items[0], false);
});

test("room reviews keep unknown rooms indistinguishable from private supply", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/rooms/unknown-room/reviews" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, "ROOM_NOT_FOUND");
});

test("availability intersects several rooms and explains the maximum duration", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/availability/search",
    payload: {
      roomIds: [roomIds.kosmos, roomIds.safari],
      date: "2026-07-18",
      durationMinutes: 120,
      preferredTime: "20:00",
      guests: 8,
    },
  });
  assert.equal(response.statusCode, 200);
  const windows = response.json().windows;
  assert.ok(windows.some((window: { startsAt: string; exactMatch: boolean }) => window.startsAt.includes("T20:00:00") && window.exactMatch));
  assert.ok(windows.some((window: { startsAt: string }) => window.startsAt.includes("T15:00:00")));
  assert.ok(!windows.some((window: { startsAt: string }) => window.startsAt.includes("T18:00:00")));
  assert.equal(windows.find((window: { startsAt: string }) => window.startsAt.includes("T20:00:00"))?.maximumDurationMinutes, 120);
});

test("availability rejects unknown rooms and over-capacity groups", async () => {
  const unknown = await app.inject({
    method: "POST",
    url: "/v1/availability/search",
    payload: { roomIds: ["unknown-room"], date: "2026-07-18", durationMinutes: 120 },
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, "ROOM_NOT_FOUND");

  const capacity = await app.inject({
    method: "POST",
    url: "/v1/availability/search",
    payload: { roomIds: [roomIds.kosmos, roomIds.safari], date: "2026-07-18", durationMinutes: 120, guests: 15 },
  });
  assert.equal(capacity.statusCode, 200);
  assert.deepEqual(capacity.json().windows, []);
});

test("availability rolls after-midnight windows into the next calendar day", () => {
  const nightRoom: Room = {
    id: roomIds.voiceVip,
    slug: "night-room",
    venueId: "10000000-0000-4000-8000-000000000002",
    title: "Ночная комната",
    subtitle: "",
    type: "lounge",
    capacityMin: 1,
    capacityMax: 12,
    pricePerHour: 2600,
    minimumHours: 1,
    rating: 4.8,
    reviewCount: 1,
    description: "",
    rules: "",
    promotion: null,
    features: [],
    tags: [],
    photoPaths: [],
    services: [],
    opensAtHour: 22,
    closesAtHour: 26,
    bufferMinutes: 0,
    defaultBlocked: [],
    blockedByDate: {},
    publicationStatus: "published",
  };
  const windows = availabilityForRoom(nightRoom, "2026-07-18", 60, "01:00");
  const preferred = windows.find((window) => window.exactMatch);
  assert.equal(preferred?.startsAt, "2026-07-19T01:00:00+03:00");
  assert.ok(windows.every((window) => !window.startsAt.includes("T24:") && !window.startsAt.includes("T25:")));
});

test("CORS allows the published Rooms origin", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/v1/rooms?city=Воронеж",
    headers: {
      origin: "https://amodous.github.io",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "https://amodous.github.io");
});
