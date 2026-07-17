import "dotenv/config";
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { LocalPhotoStorage } from "./media.js";
import {
  NotificationCipher,
  NotificationDispatcher,
  notificationProviderConfigFromEnv,
  startNotificationWorker,
} from "./notifications.js";
import { createCatalogStorage } from "./storage.js";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || 3001);
const publicSiteUrl = process.env.PUBLIC_SITE_URL?.trim() || "https://amodous.github.io/Rooms-bron";
const publicApiUrl = process.env.PUBLIC_API_URL?.trim() || `http://${host}:${port}`;
const mediaStorageDir = resolve(process.env.MEDIA_STORAGE_DIR?.trim() || "server-data/media");
const authTokenSecret = process.env.AUTH_TOKEN_SECRET?.trim() || "";
const effectiveAuthTokenSecret = authTokenSecret || "rooms-local-development-secret-change-me-2026";
const notificationEncryptionKey = process.env.NOTIFICATION_ENCRYPTION_KEY?.trim() || effectiveAuthTokenSecret;
const notificationWorkerEnabled = process.env.NOTIFICATION_WORKER_ENABLED === undefined
  ? true
  : String(process.env.NOTIFICATION_WORKER_ENABLED).trim().toLowerCase() === "true";
const notificationWorkerIntervalMs = Number(process.env.NOTIFICATION_WORKER_INTERVAL_MS || 5000);
const secureCookies = String(process.env.AUTH_COOKIE_SECURE || "false").trim().toLowerCase() === "true";
const enableDemoPayments = process.env.ENABLE_DEMO_PAYMENTS === undefined
  ? process.env.NODE_ENV !== "production"
  : String(process.env.ENABLE_DEMO_PAYMENTS).trim().toLowerCase() === "true";
const exposePasswordResetToken = process.env.EXPOSE_PASSWORD_RESET_TOKEN === undefined
  ? process.env.NODE_ENV !== "production"
  : String(process.env.EXPOSE_PASSWORD_RESET_TOKEN).trim().toLowerCase() === "true";
const corsOrigins = String(process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001,http://localhost:4173,http://127.0.0.1:4173,https://amodous.github.io")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
if (process.env.DATABASE_URL?.trim() && Buffer.byteLength(authTokenSecret, "utf8") < 32) {
  throw new Error("AUTH_TOKEN_SECRET must contain at least 32 bytes when PostgreSQL is enabled.");
}
if (Buffer.byteLength(notificationEncryptionKey, "utf8") < 32) {
  throw new Error("NOTIFICATION_ENCRYPTION_KEY must contain at least 32 bytes.");
}
if (!Number.isInteger(notificationWorkerIntervalMs) || notificationWorkerIntervalMs < 1000) {
  throw new Error("NOTIFICATION_WORKER_INTERVAL_MS must be an integer of at least 1000.");
}

const storage = await createCatalogStorage();
const app = buildApp({
  publicSiteUrl,
  publicApiUrl,
  corsOrigins,
  logger: true,
  repository: storage.repository,
  authRepository: storage.authRepository,
  bookingRepository: storage.bookingRepository,
  paymentRepository: storage.paymentRepository,
  reservationRepository: storage.reservationRepository,
  partnerCatalogRepository: storage.partnerCatalogRepository,
  notificationRepository: storage.notificationRepository,
  photoStorage: new LocalPhotoStorage(mediaStorageDir),
  authTokenSecret: effectiveAuthTokenSecret,
  notificationEncryptionKey,
  secureCookies,
  enableDemoPayments,
  exposePasswordResetToken,
});
const notificationWorker = notificationWorkerEnabled
  ? startNotificationWorker(
      storage.notificationRepository,
      new NotificationCipher(notificationEncryptionKey),
      new NotificationDispatcher(notificationProviderConfigFromEnv(), (message) => app.log.info(message)),
      notificationWorkerIntervalMs,
      (error) => app.log.error({ err: error }, "Rooms notification worker failed"),
    )
  : null;
app.addHook("onClose", async () => {
  notificationWorker?.stop();
  await storage.close();
});

const stop = async (signal: string) => {
  app.log.info({ signal }, "stopping Rooms API");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await app.listen({ host, port });
  app.log.info({ host, port, storage: storage.repository.storage, notificationWorker: Boolean(notificationWorker) }, "Rooms API is ready");
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
