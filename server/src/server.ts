import "dotenv/config";
import { buildApp } from "./app.js";
import { createCatalogStorage } from "./storage.js";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const publicSiteUrl = process.env.PUBLIC_SITE_URL?.trim() || "https://amodous.github.io/Rooms-bron";
const authTokenSecret = process.env.AUTH_TOKEN_SECRET?.trim() || "";
const secureCookies = String(process.env.AUTH_COOKIE_SECURE || "false").trim().toLowerCase() === "true";
const enableDemoPayments = process.env.ENABLE_DEMO_PAYMENTS === undefined
  ? process.env.NODE_ENV !== "production"
  : String(process.env.ENABLE_DEMO_PAYMENTS).trim().toLowerCase() === "true";
const corsOrigins = String(process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000,http://localhost:4173,http://127.0.0.1:4173,https://amodous.github.io")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
if (process.env.DATABASE_URL?.trim() && Buffer.byteLength(authTokenSecret, "utf8") < 32) {
  throw new Error("AUTH_TOKEN_SECRET must contain at least 32 bytes when PostgreSQL is enabled.");
}

const storage = await createCatalogStorage();
const app = buildApp({
  publicSiteUrl,
  corsOrigins,
  logger: true,
  repository: storage.repository,
  authRepository: storage.authRepository,
  bookingRepository: storage.bookingRepository,
  paymentRepository: storage.paymentRepository,
  reservationRepository: storage.reservationRepository,
  authTokenSecret: authTokenSecret || "rooms-local-development-secret-change-me-2026",
  secureCookies,
  enableDemoPayments,
});
app.addHook("onClose", () => storage.close());

const stop = async (signal: string) => {
  app.log.info({ signal }, "stopping Rooms API");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await app.listen({ host, port });
  app.log.info({ host, port, storage: storage.repository.storage }, "Rooms API is ready");
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
