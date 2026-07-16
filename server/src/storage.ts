import { Pool, type PoolConfig } from "pg";
import { MemoryAuthRepository, PostgresAuthRepository, type AuthRepository } from "./auth.js";
import { MemoryBookingRepository, PostgresBookingRepository, type BookingRepository } from "./bookings.js";
import { MemoryCatalogRepository, type CatalogRepository } from "./catalog.js";
import { MemoryPaymentRepository, PostgresPaymentRepository, type PaymentRepository } from "./payments.js";
import { PostgresCatalogRepository } from "./postgresCatalog.js";
import { MemoryPartnerReservationRepository, PostgresPartnerReservationRepository, type PartnerReservationRepository } from "./reservations.js";

export interface CatalogStorage {
  repository: CatalogRepository;
  authRepository: AuthRepository;
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  reservationRepository: PartnerReservationRepository;
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
  if (!connectionString) {
    const bookingRepository = new MemoryBookingRepository();
    const repository = new MemoryCatalogRepository();
    return {
      repository,
      authRepository: new MemoryAuthRepository(),
      bookingRepository,
      paymentRepository: new MemoryPaymentRepository(bookingRepository),
      reservationRepository: new MemoryPartnerReservationRepository(bookingRepository, repository),
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
  return {
    repository: new PostgresCatalogRepository(pool),
    authRepository: new PostgresAuthRepository(pool),
    bookingRepository: new PostgresBookingRepository(pool),
    paymentRepository: new PostgresPaymentRepository(pool),
    reservationRepository: new PostgresPartnerReservationRepository(pool),
    close: () => pool.end(),
  };
}
