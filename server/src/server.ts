import "dotenv/config";
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { LocalPhotoStorage } from "./media.js";
import {
  NotificationCipher,
  NotificationDispatcher,
  NotificationService,
  notificationProviderConfigFromEnv,
  startNotificationWorker,
} from "./notifications.js";
import { fiscalReceiptProviderFromEnv, startFiscalReceiptWorker } from "./receipts.js";
import { startRefundWorker } from "./refunds.js";
import { createCatalogStorage } from "./storage.js";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || 3001);
const productionMode = process.env.NODE_ENV === "production";
const publicSiteUrl = process.env.PUBLIC_SITE_URL?.trim() || (productionMode ? "https://amodous.github.io/Rooms-bron" : `http://${host}:${port}`);
const publicApiUrl = process.env.PUBLIC_API_URL?.trim() || `http://${host}:${port}`;
const mediaStorageDir = resolve(process.env.MEDIA_STORAGE_DIR?.trim() || "server-data/media");
const authTokenSecret = process.env.AUTH_TOKEN_SECRET?.trim() || "";
const effectiveAuthTokenSecret = authTokenSecret || "rooms-local-development-secret-change-me-2026";
const explicitNotificationEncryptionKey = process.env.NOTIFICATION_ENCRYPTION_KEY?.trim() || "";
const explicitFinanceEncryptionKey = process.env.FINANCE_ENCRYPTION_KEY?.trim() || "";
const notificationEncryptionKey = explicitNotificationEncryptionKey || effectiveAuthTokenSecret;
const financeEncryptionKey = explicitFinanceEncryptionKey || effectiveAuthTokenSecret;
const notificationWorkerEnabled = process.env.NOTIFICATION_WORKER_ENABLED === undefined
  ? true
  : String(process.env.NOTIFICATION_WORKER_ENABLED).trim().toLowerCase() === "true";
const notificationWorkerIntervalMs = Number(process.env.NOTIFICATION_WORKER_INTERVAL_MS || 5000);
const fiscalReceiptProvider = fiscalReceiptProviderFromEnv();
const fiscalReceiptWorkerEnabled = String(process.env.FISCAL_RECEIPT_WORKER_ENABLED || "false").trim().toLowerCase() === "true";
const fiscalReceiptWorkerIntervalMs = Number(process.env.FISCAL_RECEIPT_WORKER_INTERVAL_MS || 5000);
const fiscalReceiptWorkerBatchSize = Number(process.env.FISCAL_RECEIPT_WORKER_BATCH_SIZE || 20);
const refundWorkerEnabled = process.env.REFUND_WORKER_ENABLED === undefined
  ? String(process.env.PAYMENT_PROVIDER || "demo").trim().toLowerCase() === "sber"
  : String(process.env.REFUND_WORKER_ENABLED).trim().toLowerCase() === "true";
const refundWorkerIntervalMs = Number(process.env.REFUND_WORKER_INTERVAL_MS || 5000);
const refundWorkerBatchSize = Number(process.env.REFUND_WORKER_BATCH_SIZE || 20);
const secureCookies = process.env.AUTH_COOKIE_SECURE === undefined
  ? productionMode
  : String(process.env.AUTH_COOKIE_SECURE).trim().toLowerCase() === "true";
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
if ((productionMode || process.env.DATABASE_URL?.trim()) && Buffer.byteLength(authTokenSecret, "utf8") < 32) {
  throw new Error("AUTH_TOKEN_SECRET must contain at least 32 bytes in production or when PostgreSQL is enabled.");
}
if (productionMode && !secureCookies) throw new Error("AUTH_COOKIE_SECURE must be true in production.");
if (productionMode && enableDemoPayments) throw new Error("ENABLE_DEMO_PAYMENTS must be false in production.");
if (productionMode && exposePasswordResetToken) throw new Error("EXPOSE_PASSWORD_RESET_TOKEN must be false in production.");
if (productionMode && Buffer.byteLength(explicitNotificationEncryptionKey, "utf8") < 32) {
  throw new Error("NOTIFICATION_ENCRYPTION_KEY must contain at least 32 bytes in production.");
}
if (productionMode && Buffer.byteLength(explicitFinanceEncryptionKey, "utf8") < 32) {
  throw new Error("FINANCE_ENCRYPTION_KEY must contain at least 32 bytes in production.");
}
if (productionMode && new Set([authTokenSecret, explicitNotificationEncryptionKey, explicitFinanceEncryptionKey]).size !== 3) {
  throw new Error("Production authentication, notification and finance keys must be different.");
}
if (productionMode && (!publicSiteUrl.startsWith("https://") || !publicApiUrl.startsWith("https://"))) {
  throw new Error("PUBLIC_SITE_URL and PUBLIC_API_URL must use HTTPS in production.");
}
if (productionMode && corsOrigins.some((origin) => origin === "*" || !origin.startsWith("https://"))) {
  throw new Error("CORS_ORIGINS must contain only explicit HTTPS origins in production.");
}
if (Buffer.byteLength(notificationEncryptionKey, "utf8") < 32) {
  throw new Error("NOTIFICATION_ENCRYPTION_KEY must contain at least 32 bytes.");
}
if (Buffer.byteLength(financeEncryptionKey, "utf8") < 32) {
  throw new Error("FINANCE_ENCRYPTION_KEY must contain at least 32 bytes.");
}
if (!Number.isInteger(notificationWorkerIntervalMs) || notificationWorkerIntervalMs < 1000) {
  throw new Error("NOTIFICATION_WORKER_INTERVAL_MS must be an integer of at least 1000.");
}
if (!Number.isInteger(fiscalReceiptWorkerIntervalMs) || fiscalReceiptWorkerIntervalMs < 1000) {
  throw new Error("FISCAL_RECEIPT_WORKER_INTERVAL_MS must be an integer of at least 1000.");
}
if (!Number.isInteger(fiscalReceiptWorkerBatchSize) || fiscalReceiptWorkerBatchSize < 1 || fiscalReceiptWorkerBatchSize > 100) {
  throw new Error("FISCAL_RECEIPT_WORKER_BATCH_SIZE must be an integer between 1 and 100.");
}
if (!Number.isInteger(refundWorkerIntervalMs) || refundWorkerIntervalMs < 1000) {
  throw new Error("REFUND_WORKER_INTERVAL_MS must be an integer of at least 1000.");
}
if (!Number.isInteger(refundWorkerBatchSize) || refundWorkerBatchSize < 1 || refundWorkerBatchSize > 100) {
  throw new Error("REFUND_WORKER_BATCH_SIZE must be an integer between 1 and 100.");
}
if (fiscalReceiptWorkerEnabled && !fiscalReceiptProvider) {
  throw new Error("FISCAL_RECEIPT_WORKER_ENABLED requires a configured FISCAL_RECEIPT_MODE.");
}

const storage = await createCatalogStorage();
if (refundWorkerEnabled && !storage.refundProvider) {
  await storage.close();
  throw new Error("REFUND_WORKER_ENABLED requires PAYMENT_PROVIDER=sber and configured Sber credentials.");
}
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
  reviewRepository: storage.reviewRepository,
  supportRepository: storage.supportRepository,
  financeRepository: storage.financeRepository,
  receiptRepository: storage.receiptRepository,
  refundRepository: storage.refundRepository,
  photoStorage: new LocalPhotoStorage(mediaStorageDir),
  authTokenSecret: effectiveAuthTokenSecret,
  notificationEncryptionKey,
  productionMode,
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
const fiscalReceiptWorker = fiscalReceiptWorkerEnabled && fiscalReceiptProvider
  ? startFiscalReceiptWorker(
      storage.receiptRepository,
      fiscalReceiptProvider,
      fiscalReceiptWorkerIntervalMs,
      fiscalReceiptWorkerBatchSize,
      (error) => app.log.error({ err: error }, "Rooms fiscal receipt worker failed"),
    )
  : null;
const refundNotificationService = new NotificationService(
  storage.notificationRepository,
  new NotificationCipher(notificationEncryptionKey),
);
const refundWorker = refundWorkerEnabled && storage.refundProvider
  ? startRefundWorker(
      storage.refundRepository,
      storage.refundProvider,
      refundWorkerIntervalMs,
      refundWorkerBatchSize,
      async (job) => {
        await refundNotificationService.enqueueBookingClient(job.bookingId, {
          eventKey: "refund_completed",
          title: `Возврат по заявке ${job.publicNumber} выполнен`,
          body: `Возвращено ${job.amount.toLocaleString("ru-RU")} руб. Срок зачисления зависит от банка клиента.`,
          dedupeKey: `refund-completed|${job.refundId}`,
        });
      },
      (error) => app.log.error({ err: error }, "Rooms refund worker failed"),
    )
  : null;
app.addHook("onClose", async () => {
  notificationWorker?.stop();
  fiscalReceiptWorker?.stop();
  refundWorker?.stop();
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
  app.log.info({
    host,
    port,
    storage: storage.repository.storage,
    notificationWorker: Boolean(notificationWorker),
    fiscalReceiptWorker: Boolean(fiscalReceiptWorker),
    fiscalReceiptProvider: fiscalReceiptProvider?.providerName ?? "disabled",
    refundWorker: Boolean(refundWorker),
  }, "Rooms API is ready");
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
