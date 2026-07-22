import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { hashPassword, MemoryAuthRepository } from "../src/auth.js";
import {
  MemoryNotificationRepository,
  NotificationCipher,
  NotificationDispatcher,
  NotificationService,
  processNotificationBatch,
} from "../src/notifications.js";

const secret = "rooms-notification-test-secret-with-32-bytes";

test("notification payloads are authenticated and encrypted", () => {
  const cipher = new NotificationCipher(secret);
  const encrypted = cipher.encrypt("Секретная ссылка https://rooms.test/reset/token");
  assert.match(encrypted, /^enc:v1:/);
  assert.doesNotMatch(encrypted, /rooms\.test/);
  assert.equal(cipher.decrypt(encrypted), "Секретная ссылка https://rooms.test/reset/token");
  const parts = encrypted.split(":");
  const encryptedPayload = parts[4]!;
  const position = Math.floor(encryptedPayload.length / 2);
  parts[4] = `${encryptedPayload.slice(0, position)}${encryptedPayload[position] === "A" ? "B" : "A"}${encryptedPayload.slice(position + 1)}`;
  const tampered = parts.join(":");
  assert.throws(() => cipher.decrypt(tampered));
});

test("worker deduplicates, masks and purges delivered notification payloads", async () => {
  const repository = new MemoryNotificationRepository();
  const cipher = new NotificationCipher(secret);
  const notifications = new NotificationService(repository, cipher);
  const user = { id: "10000000-0000-4000-8000-000000000099", name: "Игорь", email: "igor@example.test" };
  await notifications.updateSettings(user, {
    emailEnabled: true,
    emailAddress: user.email,
    telegramEnabled: true,
    telegramChatId: "123456789",
  });
  const event = {
    eventKey: "booking_confirmed",
    title: "Бронь подтверждена",
    body: "Содержимое, которое нельзя писать в журнал",
    dedupeKey: "booking-confirmed|test-1",
  };
  const first = await notifications.enqueueUser(user, event);
  const duplicate = await notifications.enqueueUser(user, event);
  assert.equal(first.length, 2);
  assert.equal(duplicate.length, 0);
  assert.ok(first.every((delivery) => delivery.target !== user.email && !delivery.target.includes("123456789")));
  const queued = await repository.listAll();
  assert.ok(queued.every((delivery) => delivery.body.startsWith("enc:v1:")));
  assert.ok(queued.every((delivery) => !delivery.body.includes("Содержимое")));

  const logs: string[] = [];
  const summary = await processNotificationBatch(
    repository,
    cipher,
    new NotificationDispatcher({ mode: "log", smtpUrl: "", emailFrom: "", telegramBotToken: "" }, (message) => logs.push(message)),
  );
  assert.deepEqual(summary, { claimed: 2, sent: 2, failed: 0 });
  const sent = await repository.listAll();
  assert.ok(sent.every((delivery) => delivery.status === "sent" && delivery.body === "purged:v1"));
  assert.ok(logs.every((entry) => !entry.includes(event.body) && !entry.includes(user.email!)));
});

test("authenticated notification settings, tests and admin queue use server data", async () => {
  const adminPassword = "admin-notifications-2026";
  const authRepository = new MemoryAuthRepository([{
    id: "50000000-0000-4000-8000-000000000099",
    role: "admin",
    name: "Администратор Rooms",
    email: "admin@rooms.test",
    phone: null,
    city: "Воронеж",
    passwordHash: await hashPassword(adminPassword),
    passwordResetRequired: false,
    blockedAt: null,
  }]);
  const notificationRepository = new MemoryNotificationRepository();
  const app = buildApp({
    logger: false,
    authRepository,
    notificationRepository,
    notificationEncryptionKey: secret,
    exposePasswordResetToken: true,
  });
  await app.ready();
  try {
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/client/register",
      payload: {
        name: "Клиент уведомлений",
        email: "notice.client@rooms.test",
        phone: "+7 900 818-20-26",
        city: "Воронеж",
        password: "notice-client-2026",
        legal: { termsVersion: "test-1", privacyVersion: "test-1", acceptedAt: new Date().toISOString() },
      },
    });
    assert.equal(registration.statusCode, 201);
    const clientToken = registration.json().accessToken as string;
    const clientHeaders = { authorization: `Bearer ${clientToken}` };

    const settings = await app.inject({ method: "GET", url: "/v1/me/notification-settings", headers: clientHeaders });
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.json().emailAddress, "notice.client@rooms.test");
    assert.equal(settings.json().emailEnabled, true);

    const invalidTelegram = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-settings",
      headers: clientHeaders,
      payload: { emailEnabled: true, emailAddress: "notice.client@rooms.test", telegramEnabled: true, telegramChatId: "@x" },
    });
    assert.equal(invalidTelegram.statusCode, 400);
    assert.equal(invalidTelegram.json().code, "TELEGRAM_CHAT_REQUIRED");

    const updated = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-settings",
      headers: clientHeaders,
      payload: { emailEnabled: true, emailAddress: "delivery@rooms.test", telegramEnabled: true, telegramChatId: "123456789" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().telegramEnabled, true);

    const testDelivery = await app.inject({ method: "POST", url: "/v1/me/notification-settings/test", headers: clientHeaders });
    assert.equal(testDelivery.statusCode, 202);
    assert.equal(testDelivery.json().deliveries.length, 2);

    const ownQueue = await app.inject({ method: "GET", url: "/v1/me/notification-deliveries", headers: clientHeaders });
    assert.equal(ownQueue.statusCode, 200);
    assert.ok(ownQueue.json().length >= 3);
    assert.ok(ownQueue.json().every((delivery: Record<string, unknown>) => !("body" in delivery) && String(delivery.target).includes("***")));

    const unknownReset = await app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { login: "nobody@rooms.test" } });
    assert.equal(unknownReset.statusCode, 202);
    const knownReset = await app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { login: "notice.client@rooms.test" } });
    assert.equal(knownReset.statusCode, 202);
    const resetDeliveries = (await notificationRepository.listAll()).filter((delivery) => delivery.eventKey === "password_reset_requested");
    assert.equal(resetDeliveries.length, 1);
    assert.doesNotMatch(resetDeliveries[0]!.body, new RegExp(knownReset.json().demoToken));

    const forbidden = await app.inject({ method: "GET", url: "/v1/admin/notification-deliveries", headers: clientHeaders });
    assert.equal(forbidden.statusCode, 403);
    const adminLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { login: "admin@rooms.test", password: adminPassword },
    });
    assert.equal(adminLogin.statusCode, 200);
    const adminQueue = await app.inject({
      method: "GET",
      url: "/v1/admin/notification-deliveries?limit=20",
      headers: { authorization: `Bearer ${adminLogin.json().accessToken}` },
    });
    assert.equal(adminQueue.statusCode, 200);
    assert.ok(adminQueue.json().length >= ownQueue.json().length);
  } finally {
    await app.close();
  }
});
