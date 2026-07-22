import { Pool, type PoolConfig } from "pg";
import { MemoryAuthRepository, PostgresAuthRepository, type AuthRepository } from "./auth.js";
import { MemoryBookingRepository, PostgresBookingRepository, type BookingRepository } from "./bookings.js";
import { MemoryCatalogRepository, type CatalogRepository } from "./catalog.js";
import { MemoryPaymentRepository, PostgresPaymentRepository, type PaymentRepository } from "./payments.js";
import { MemoryNotificationRepository, PostgresNotificationRepository, type NotificationRepository } from "./notifications.js";
import {
  MemoryPartnerCatalogRepository,
  PostgresPartnerCatalogRepository,
  type PartnerCatalogRepository,
} from "./partnerCatalog.js";
import { PostgresCatalogRepository } from "./postgresCatalog.js";
import { MemoryPartnerReservationRepository, PostgresPartnerReservationRepository, type PartnerReservationRepository } from "./reservations.js";
import { MemoryReviewRepository, PostgresReviewRepository, type ReviewRepository } from "./reviews.js";
import { MemorySupportRepository, PostgresSupportRepository, type SupportRepository } from "./support.js";
import { FinanceCipher, MemoryFinanceRepository, PostgresFinanceRepository, type FinanceRepository } from "./finance.js";
import { SberPaymentGateway, type PaymentGateway } from "./paymentGateway.js";
import { MemoryFiscalReceiptRepository, PostgresFiscalReceiptRepository, type FiscalReceiptRepository } from "./receipts.js";
import { MemoryRefundRepository, PostgresRefundRepository, type RefundRepository } from "./refunds.js";

export interface CatalogStorage {
  repository: CatalogRepository;
  authRepository: AuthRepository;
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  reservationRepository: PartnerReservationRepository;
  partnerCatalogRepository: PartnerCatalogRepository;
  notificationRepository: NotificationRepository;
  reviewRepository: ReviewRepository;
  supportRepository: SupportRepository;
  financeRepository: FinanceRepository;
  receiptRepository: FiscalReceiptRepository;
  refundRepository: RefundRepository;
  refundProvider: PaymentGateway | null;
  close(): Promise<void>;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sslConfig(value: string | undefined): PoolConfig["ssl"] {
  const mode = String(value ?? "disable").trim().toLowerCase();
  if (mode === "disable" || mode === "false" || mode === "0") return false;
  if (mode === "verify-full") return { rejectUnauthorized: true };
  if (mode === "require" || mode === "true" || mode === "1") return { rejectUnauthorized: false };
  throw new Error("DATABASE_SSL must be disable, require or verify-full.");
}

export function paymentGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentGateway | null {
  const provider = String(env.PAYMENT_PROVIDER ?? "demo").trim().toLowerCase();
  if (provider === "demo") return null;
  if (provider !== "sber") throw new Error("PAYMENT_PROVIDER must be demo or sber.");
  const baseUrl = env.SBER_API_BASE_URL?.trim();
  const userName = env.SBER_USERNAME?.trim();
  const password = env.SBER_PASSWORD;
  if (!baseUrl || !userName || !password) {
    throw new Error("SBER_API_BASE_URL, SBER_USERNAME and SBER_PASSWORD are required when PAYMENT_PROVIDER=sber.");
  }
  return new SberPaymentGateway({
    baseUrl,
    userName,
    password,
    timeoutMs: positiveInteger(env.SBER_REQUEST_TIMEOUT_MS, 8000),
  });
}

export function postgresPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL commands.");
  return {
    connectionString,
    ssl: sslConfig(env.DATABASE_SSL),
    max: positiveInteger(env.DATABASE_POOL_MAX, 10),
    connectionTimeoutMillis: positiveInteger(env.DATABASE_CONNECT_TIMEOUT_MS, 5000),
    idleTimeoutMillis: positiveInteger(env.DATABASE_IDLE_TIMEOUT_MS, 30000),
    application_name: "rooms-api",
  };
}

export async function createCatalogStorage(env: NodeJS.ProcessEnv = process.env): Promise<CatalogStorage> {
  const connectionString = env.DATABASE_URL?.trim();
  const paymentGateway = paymentGatewayFromEnv(env);
  if (!connectionString) {
    if (paymentGateway) throw new Error("DATABASE_URL is required when PAYMENT_PROVIDER=sber.");
    const bookingRepository = new MemoryBookingRepository();
    const repository = new MemoryCatalogRepository();
    const supportRepository = new MemorySupportRepository(bookingRepository);
    return {
      repository,
      authRepository: new MemoryAuthRepository(),
      bookingRepository,
      paymentRepository: new MemoryPaymentRepository(bookingRepository),
      reservationRepository: new MemoryPartnerReservationRepository(bookingRepository, repository),
      partnerCatalogRepository: new MemoryPartnerCatalogRepository(),
      notificationRepository: new MemoryNotificationRepository(),
      reviewRepository: new MemoryReviewRepository(bookingRepository, repository),
      supportRepository,
      financeRepository: new MemoryFinanceRepository(bookingRepository, supportRepository),
      receiptRepository: new MemoryFiscalReceiptRepository(),
      refundRepository: new MemoryRefundRepository(),
      refundProvider: null,
      close: async () => undefined,
    };
  }
  const pool = new Pool(postgresPoolConfig(env));
  try {
    await pool.query("select 1 as ready");
  } catch (error) {
    await pool.end();
    throw new Error("Rooms could not connect to PostgreSQL using DATABASE_URL.", { cause: error });
  }
  const repository = new PostgresCatalogRepository(pool);
  const bookingRepository = new PostgresBookingRepository(pool);
  const supportRepository = new PostgresSupportRepository(pool);
  const financeEncryptionKey = env.FINANCE_ENCRYPTION_KEY?.trim()
    || env.AUTH_TOKEN_SECRET?.trim()
    || "rooms-local-development-secret-change-me-2026";
  return {
    repository,
    authRepository: new PostgresAuthRepository(pool),
    bookingRepository,
    paymentRepository: new PostgresPaymentRepository(
      pool,
      paymentGateway,
      env.PUBLIC_SITE_URL?.trim() || "https://amodous.github.io/Rooms-bron/",
    ),
    reservationRepository: new PostgresPartnerReservationRepository(pool),
    partnerCatalogRepository: new PostgresPartnerCatalogRepository(pool),
    notificationRepository: new PostgresNotificationRepository(pool),
    reviewRepository: new PostgresReviewRepository(pool, bookingRepository, repository),
    supportRepository,
    financeRepository: new PostgresFinanceRepository(pool, new FinanceCipher(financeEncryptionKey)),
    receiptRepository: new PostgresFiscalReceiptRepository(pool),
    refundRepository: new PostgresRefundRepository(pool),
    refundProvider: paymentGateway,
    close: () => pool.end(),
  };
}
