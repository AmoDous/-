import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";

export type FiscalReceiptType = "sale" | "refund";
export type FiscalReceiptQueueStatus = "queued" | "processing" | "succeeded" | "failed" | "cancelled";
export type FiscalReceiptActorRole = "admin" | "accountant";

export interface FiscalReceiptItem {
  name: string;
  quantity: number;
  price: number;
  amount: number;
  paymentObject: string;
  paymentMethod: string;
  tax: string;
}

export interface FiscalReceiptJob {
  id: string;
  paymentId: string;
  bookingId: string;
  publicNumber: string;
  receiptType: FiscalReceiptType;
  amount: number;
  currency: "RUB";
  customerEmail: string | null;
  customerPhone: string;
  items: FiscalReceiptItem[];
  attempts: number;
  createdAt: string;
}

export interface FiscalReceiptIssueResult {
  providerReceiptId: string;
  fiscalDocumentNumber: string | null;
  fiscalSign: string | null;
  receiptUrl: string | null;
  providerPayload?: Record<string, unknown>;
}

export interface FiscalReceiptProvider {
  readonly providerName: string;
  issue(job: FiscalReceiptJob): Promise<FiscalReceiptIssueResult>;
}

export type FiscalReceiptActionResult = {
  outcome: "updated" | "not_found" | "state_conflict";
  status: FiscalReceiptQueueStatus | null;
};

export interface FiscalReceiptRepository {
  readonly storage: "memory" | "postgresql";
  claimBatch(limit: number): Promise<FiscalReceiptJob[]>;
  markSucceeded(id: string, provider: string, result: FiscalReceiptIssueResult): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: string | null): Promise<void>;
  retry(id: string, actorId: string, actorRole: FiscalReceiptActorRole): Promise<FiscalReceiptActionResult>;
  cancel(id: string, actorId: string, actorRole: FiscalReceiptActorRole): Promise<FiscalReceiptActionResult>;
}

export interface MemoryFiscalReceiptSeed extends Omit<FiscalReceiptJob, "attempts"> {
  status?: FiscalReceiptQueueStatus;
  attempts?: number;
  nextAttemptAt?: string | null;
  processingStartedAt?: string | null;
}

interface MemoryFiscalReceiptRecord extends FiscalReceiptJob {
  status: FiscalReceiptQueueStatus;
  nextAttemptAt: string | null;
  processingStartedAt: string | null;
  provider: string | null;
  providerReceiptId: string | null;
  lastError: string | null;
}

const MAX_RECEIPT_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

export class MemoryFiscalReceiptRepository implements FiscalReceiptRepository {
  readonly storage = "memory" as const;
  private readonly records = new Map<string, MemoryFiscalReceiptRecord>();

  constructor(seeds: MemoryFiscalReceiptSeed[] = [], private readonly now: () => Date = () => new Date()) {
    for (const seed of seeds) this.add(seed);
  }

  add(seed: MemoryFiscalReceiptSeed): void {
    this.records.set(seed.id, {
      ...structuredClone(seed),
      status: seed.status ?? "queued",
      attempts: seed.attempts ?? 0,
      nextAttemptAt: seed.nextAttemptAt ?? null,
      processingStartedAt: seed.processingStartedAt ?? null,
      provider: null,
      providerReceiptId: null,
      lastError: null,
    });
  }

  inspect(id: string): MemoryFiscalReceiptRecord | null {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async claimBatch(limit: number): Promise<FiscalReceiptJob[]> {
    const now = this.now();
    const nowMs = now.getTime();
    for (const record of this.records.values()) {
      const startedAt = new Date(record.processingStartedAt ?? 0).getTime();
      if (record.status === "processing" && startedAt <= nowMs - STALE_PROCESSING_MS) {
        record.status = record.attempts >= MAX_RECEIPT_ATTEMPTS ? "failed" : "queued";
        record.processingStartedAt = null;
        record.lastError = "Предыдущая обработка чека не завершилась.";
      }
    }
    const claimed = [...this.records.values()]
      .filter((record) => (
        (record.status === "queued" && record.attempts < MAX_RECEIPT_ATTEMPTS)
        || (record.status === "failed"
          && record.attempts < MAX_RECEIPT_ATTEMPTS
          && record.nextAttemptAt !== null
          && new Date(record.nextAttemptAt).getTime() <= nowMs)
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 100));
    return claimed.map((record) => {
      record.status = "processing";
      record.attempts += 1;
      record.processingStartedAt = now.toISOString();
      record.nextAttemptAt = null;
      return this.publicJob(record);
    });
  }

  async markSucceeded(id: string, provider: string, result: FiscalReceiptIssueResult): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.status !== "processing") return;
    record.status = "succeeded";
    record.provider = provider;
    record.providerReceiptId = result.providerReceiptId;
    record.processingStartedAt = null;
    record.nextAttemptAt = null;
    record.lastError = null;
  }

  async markFailed(id: string, error: string, nextAttemptAt: string | null): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.status !== "processing") return;
    record.status = "failed";
    record.lastError = error;
    record.nextAttemptAt = nextAttemptAt;
    record.processingStartedAt = null;
  }

  async retry(id: string, _actorId: string, _actorRole: FiscalReceiptActorRole): Promise<FiscalReceiptActionResult> {
    const record = this.records.get(id);
    if (!record) return { outcome: "not_found", status: null };
    if (!["failed", "cancelled"].includes(record.status)) return { outcome: "state_conflict", status: record.status };
    record.status = "queued";
    record.attempts = 0;
    record.nextAttemptAt = null;
    record.processingStartedAt = null;
    record.lastError = null;
    return { outcome: "updated", status: record.status };
  }

  async cancel(id: string, _actorId: string, _actorRole: FiscalReceiptActorRole): Promise<FiscalReceiptActionResult> {
    const record = this.records.get(id);
    if (!record) return { outcome: "not_found", status: null };
    if (!["queued", "failed"].includes(record.status)) return { outcome: "state_conflict", status: record.status };
    record.status = "cancelled";
    record.nextAttemptAt = null;
    record.processingStartedAt = null;
    return { outcome: "updated", status: record.status };
  }

  private publicJob(record: MemoryFiscalReceiptRecord): FiscalReceiptJob {
    return {
      id: record.id,
      paymentId: record.paymentId,
      bookingId: record.bookingId,
      publicNumber: record.publicNumber,
      receiptType: record.receiptType,
      amount: record.amount,
      currency: "RUB",
      customerEmail: record.customerEmail,
      customerPhone: record.customerPhone,
      items: structuredClone(record.items),
      attempts: record.attempts,
      createdAt: record.createdAt,
    };
  }
}

interface FiscalReceiptJobRow extends QueryResultRow {
  id: string;
  payment_id: string;
  booking_id: string;
  public_number: string;
  receipt_type: FiscalReceiptType;
  amount: string | number;
  currency: string;
  client_email: string | null;
  client_phone: string;
  items: unknown;
  attempts: number;
  created_at: Date | string;
}

function receiptItems(value: unknown): FiscalReceiptItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const name = String(source.name ?? "").trim();
    const quantity = Number(source.quantity);
    const price = Number(source.price);
    const itemAmount = Number(source.amount);
    if (!name || !Number.isFinite(quantity) || !Number.isFinite(price) || !Number.isFinite(itemAmount)) return [];
    return [{
      name,
      quantity,
      price,
      amount: itemAmount,
      paymentObject: String(source.paymentObject ?? "service"),
      paymentMethod: String(source.paymentMethod ?? "prepayment"),
      tax: String(source.tax ?? "none"),
    }];
  });
}

function receiptJobFromRow(row: FiscalReceiptJobRow): FiscalReceiptJob {
  return {
    id: row.id,
    paymentId: row.payment_id,
    bookingId: row.booking_id,
    publicNumber: row.public_number,
    receiptType: row.receipt_type,
    amount: Number(row.amount),
    currency: "RUB",
    customerEmail: row.client_email?.trim() || null,
    customerPhone: row.client_phone,
    items: receiptItems(row.items),
    attempts: Number(row.attempts),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class PostgresFiscalReceiptRepository implements FiscalReceiptRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly pool: Pool) {}

  async claimBatch(limit: number): Promise<FiscalReceiptJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`update fiscal_receipts
        set status = case when attempts >= $1 then 'failed' else 'queued' end,
          processing_started_at = null,
          last_error = 'Предыдущая обработка чека не завершилась.',
          updated_at = now()
        where status = 'processing'
          and (processing_started_at is null or processing_started_at < now() - interval '10 minutes')`, [MAX_RECEIPT_ATTEMPTS]);
      const result = await client.query<FiscalReceiptJobRow>(`-- rooms:claim-fiscal-receipts
        with selected as (
          select receipt.id, booking.public_number, booking.client_email, booking.client_phone
          from fiscal_receipts receipt
          join bookings booking on booking.id = receipt.booking_id
          where (
            (receipt.status = 'queued' and receipt.attempts < $1)
            or (
              receipt.status = 'failed' and receipt.attempts < $1
              and receipt.next_attempt_at is not null and receipt.next_attempt_at <= now()
            )
          )
          order by receipt.created_at
          limit $2
          for update of receipt skip locked
        )
        update fiscal_receipts receipt
        set status = 'processing', attempts = receipt.attempts + 1,
          processing_started_at = now(), next_attempt_at = null, updated_at = now()
        from selected
        where receipt.id = selected.id
        returning receipt.id::text, receipt.payment_id::text, receipt.booking_id::text,
          selected.public_number, receipt.receipt_type, receipt.amount, receipt.currency,
          selected.client_email, selected.client_phone, receipt.items,
          receipt.attempts, receipt.created_at`, [MAX_RECEIPT_ATTEMPTS, Math.min(Math.max(limit, 1), 100)]);
      await client.query("commit");
      return result.rows.map(receiptJobFromRow);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSucceeded(id: string, provider: string, result: FiscalReceiptIssueResult): Promise<void> {
    await this.pool.query(`update fiscal_receipts
      set status = 'succeeded', provider = $2, provider_receipt_id = $3,
        fiscal_document_number = $4, fiscal_sign = $5, receipt_url = $6,
        provider_payload = $7::jsonb, completed_at = now(), processing_started_at = null,
        next_attempt_at = null, last_error = null, updated_at = now()
      where id = $1::uuid and status = 'processing'`, [
      id,
      provider,
      result.providerReceiptId,
      result.fiscalDocumentNumber,
      result.fiscalSign,
      result.receiptUrl,
      JSON.stringify(result.providerPayload ?? {}),
    ]);
  }

  async markFailed(id: string, error: string, nextAttemptAt: string | null): Promise<void> {
    await this.pool.query(`update fiscal_receipts
      set status = 'failed', last_error = $2, next_attempt_at = $3::timestamptz,
        processing_started_at = null, updated_at = now()
      where id = $1::uuid and status = 'processing'`, [id, error, nextAttemptAt]);
  }

  retry(id: string, actorId: string, actorRole: FiscalReceiptActorRole): Promise<FiscalReceiptActionResult> {
    return this.changeState(id, actorId, actorRole, "retry");
  }

  cancel(id: string, actorId: string, actorRole: FiscalReceiptActorRole): Promise<FiscalReceiptActionResult> {
    return this.changeState(id, actorId, actorRole, "cancel");
  }

  private async changeState(
    id: string,
    actorId: string,
    actorRole: FiscalReceiptActorRole,
    action: "retry" | "cancel",
  ): Promise<FiscalReceiptActionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ status: FiscalReceiptQueueStatus; attempts: number }>(`
        select status, attempts from fiscal_receipts where id = $1::uuid for update
      `, [id]);
      const record = current.rows[0];
      if (!record) {
        await client.query("rollback");
        return { outcome: "not_found", status: null };
      }
      const allowed = action === "retry"
        ? record.status === "failed" || record.status === "cancelled"
        : record.status === "queued" || record.status === "failed";
      if (!allowed) {
        await client.query("rollback");
        return { outcome: "state_conflict", status: record.status };
      }
      const nextStatus: FiscalReceiptQueueStatus = action === "retry" ? "queued" : "cancelled";
      await client.query(`update fiscal_receipts
        set status = $2, attempts = case when $2 = 'queued' then 0 else attempts end,
          next_attempt_at = null, processing_started_at = null,
          last_error = case when $2 = 'queued' then null else last_error end,
          updated_at = now()
        where id = $1::uuid`, [id, nextStatus]);
      await client.query(`insert into audit_log (
        actor_id, actor_role, action, entity_type, entity_id, before_data, after_data
      ) values ($1::uuid,$2::user_role,$3,'fiscal_receipt',$4,$5::jsonb,$6::jsonb)`, [
        actorId,
        actorRole,
        action === "retry" ? "fiscal_receipt_retried" : "fiscal_receipt_cancelled",
        id,
        JSON.stringify({ status: record.status, attempts: record.attempts }),
        JSON.stringify({ status: nextStatus, attempts: action === "retry" ? 0 : record.attempts }),
      ]);
      await client.query("commit");
      return { outcome: "updated", status: nextStatus };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class DemoFiscalReceiptProvider implements FiscalReceiptProvider {
  readonly providerName = "rooms_demo_cashbox";

  async issue(job: FiscalReceiptJob): Promise<FiscalReceiptIssueResult> {
    if (!job.items.length) throw new Error("У чека нет товарных позиций.");
    if (!job.customerEmail && !job.customerPhone) throw new Error("Для чека не указан email или телефон клиента.");
    const digest = createHash("sha256").update(`${job.id}|${job.paymentId}|${job.amount}`).digest("hex");
    return {
      providerReceiptId: `ROOMS-DEMO-RECEIPT-${job.id}`,
      fiscalDocumentNumber: digest.slice(0, 12).toUpperCase(),
      fiscalSign: digest.slice(12, 28).toUpperCase(),
      receiptUrl: null,
      providerPayload: { mode: "demo", idempotencyKey: job.id },
    };
  }
}

export function fiscalReceiptProviderFromEnv(env: NodeJS.ProcessEnv = process.env): FiscalReceiptProvider | null {
  const mode = String(env.FISCAL_RECEIPT_MODE ?? "disabled").trim().toLowerCase();
  if (mode === "disabled") return null;
  if (mode !== "demo") throw new Error("FISCAL_RECEIPT_MODE must be disabled or demo until a production cash-register adapter is configured.");
  if (String(env.NODE_ENV).trim().toLowerCase() === "production") {
    throw new Error("The demo fiscal receipt provider cannot run in production.");
  }
  return new DemoFiscalReceiptProvider();
}

function safeReceiptError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(authorization|password|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 500);
}

export interface FiscalReceiptWorkerSummary {
  claimed: number;
  succeeded: number;
  failed: number;
}

export async function processFiscalReceiptBatch(
  repository: FiscalReceiptRepository,
  provider: FiscalReceiptProvider,
  limit = 20,
  now: () => Date = () => new Date(),
): Promise<FiscalReceiptWorkerSummary> {
  const jobs = await repository.claimBatch(limit);
  const summary: FiscalReceiptWorkerSummary = { claimed: jobs.length, succeeded: 0, failed: 0 };
  for (const job of jobs) {
    try {
      if (!Number.isFinite(job.amount) || job.amount <= 0) throw new Error("Сумма чека должна быть положительной.");
      if (!job.items.length) throw new Error("У чека нет товарных позиций.");
      const itemTotal = job.items.reduce((sum, item) => sum + item.amount, 0);
      if (Math.abs(itemTotal - job.amount) > 0.009) throw new Error("Сумма позиций чека не совпадает с итогом.");
      if (!job.customerEmail && !job.customerPhone) throw new Error("Для чека не указан email или телефон клиента.");
      const result = await provider.issue(job);
      await repository.markSucceeded(job.id, provider.providerName, result);
      summary.succeeded += 1;
    } catch (error) {
      const delaySeconds = Math.min(6 * 60 * 60, 60 * 5 ** Math.max(0, job.attempts - 1));
      const nextAttemptAt = job.attempts >= MAX_RECEIPT_ATTEMPTS
        ? null
        : new Date(now().getTime() + delaySeconds * 1000).toISOString();
      await repository.markFailed(job.id, safeReceiptError(error), nextAttemptAt);
      summary.failed += 1;
    }
  }
  return summary;
}

export function startFiscalReceiptWorker(
  repository: FiscalReceiptRepository,
  provider: FiscalReceiptProvider,
  intervalMs = 5_000,
  batchSize = 20,
  onError: (error: unknown) => void = console.error,
): { stop(): void; runNow(): Promise<FiscalReceiptWorkerSummary> } {
  let active = false;
  let stopped = false;
  const runNow = async () => {
    if (active || stopped) return { claimed: 0, succeeded: 0, failed: 0 };
    active = true;
    try {
      return await processFiscalReceiptBatch(repository, provider, batchSize);
    } finally {
      active = false;
    }
  };
  const runSafely = () => void runNow().catch(onError);
  const timer = setInterval(runSafely, Math.max(intervalMs, 1_000));
  timer.unref();
  runSafely();
  return { stop: () => { stopped = true; clearInterval(timer); }, runNow };
}

export function demoFiscalReceiptSeed(overrides: Partial<MemoryFiscalReceiptSeed> = {}): MemoryFiscalReceiptSeed {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    paymentId: overrides.paymentId ?? randomUUID(),
    bookingId: overrides.bookingId ?? randomUUID(),
    publicNumber: overrides.publicNumber ?? "RMS-DEMO",
    receiptType: overrides.receiptType ?? "sale",
    amount: overrides.amount ?? 960,
    currency: "RUB",
    customerEmail: overrides.customerEmail ?? "client@rooms.test",
    customerPhone: overrides.customerPhone ?? "+79000000000",
    items: overrides.items ?? [{
      name: "Предоплата по бронированию",
      quantity: 1,
      price: overrides.amount ?? 960,
      amount: overrides.amount ?? 960,
      paymentObject: "service",
      paymentMethod: "prepayment",
      tax: "none",
    }],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.attempts !== undefined ? { attempts: overrides.attempts } : {}),
    ...(overrides.nextAttemptAt !== undefined ? { nextAttemptAt: overrides.nextAttemptAt } : {}),
    ...(overrides.processingStartedAt !== undefined ? { processingStartedAt: overrides.processingStartedAt } : {}),
  };
}
