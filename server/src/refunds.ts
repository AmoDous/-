import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import {
  PaymentGatewayError,
  type ExternalPaymentProvider,
  type GatewayRefundInput,
  type GatewayRefundStatus,
  type PaymentGateway,
} from "./paymentGateway.js";

export type RefundActorRole = "admin" | "accountant";

export interface RefundJob extends GatewayRefundInput {
  bookingId: string;
  provider: ExternalPaymentProvider;
  publicNumber: string;
  attempts: number;
  submittedAt: string | null;
  createdAt: string;
}

export interface RefundSubmission {
  providerRefundId: string;
  providerPayload: Record<string, unknown>;
}

export interface RefundRetryResult {
  outcome: "updated" | "not_found" | "state_conflict";
  status: "refund_pending" | "refunded" | "failed" | null;
}

export interface RefundRepository {
  readonly storage: "memory" | "postgresql";
  claimBatch(provider: string, limit: number): Promise<RefundJob[]>;
  markSubmitted(id: string, attempt: number, submission: RefundSubmission): Promise<boolean>;
  markSucceeded(id: string, attempt: number, submission: RefundSubmission, status: GatewayRefundStatus): Promise<boolean>;
  markFailed(id: string, attempt: number, error: string, nextAttemptAt: string | null): Promise<void>;
  retry(id: string, actorId: string, actorRole: RefundActorRole): Promise<RefundRetryResult>;
}

export interface MemoryRefundSeed extends Omit<RefundJob, "attempts" | "submittedAt"> {
  status?: "refund_pending" | "refunded" | "failed";
  attempts?: number;
  submittedAt?: string | null;
  processingStartedAt?: string | null;
  nextAttemptAt?: string | null;
}

interface MemoryRefundRecord extends RefundJob {
  status: "refund_pending" | "refunded" | "failed";
  processingStartedAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  providerRefundId: string | null;
  providerPayload: Record<string, unknown>;
}

const MAX_REFUND_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

export class MemoryRefundRepository implements RefundRepository {
  readonly storage = "memory" as const;
  private readonly records = new Map<string, MemoryRefundRecord>();

  constructor(seeds: MemoryRefundSeed[] = [], private readonly now: () => Date = () => new Date()) {
    for (const seed of seeds) this.add(seed);
  }

  add(seed: MemoryRefundSeed): void {
    this.records.set(seed.refundId, {
      ...structuredClone(seed),
      attempts: seed.attempts ?? 0,
      submittedAt: seed.submittedAt ?? null,
      status: seed.status ?? "refund_pending",
      processingStartedAt: seed.processingStartedAt ?? null,
      nextAttemptAt: seed.nextAttemptAt ?? null,
      lastError: null,
      providerRefundId: null,
      providerPayload: {},
    });
  }

  inspect(id: string): MemoryRefundRecord | null {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async claimBatch(provider: string, limit: number): Promise<RefundJob[]> {
    const now = this.now();
    const nowMs = now.getTime();
    for (const record of this.records.values()) {
      const startedAt = new Date(record.processingStartedAt ?? 0).getTime();
      if (record.status === "refund_pending" && record.processingStartedAt && startedAt <= nowMs - STALE_PROCESSING_MS) {
        record.processingStartedAt = null;
        record.lastError = "Предыдущая обработка возврата не завершилась.";
        if (record.attempts >= MAX_REFUND_ATTEMPTS) record.status = "failed";
      }
    }
    const claimed = [...this.records.values()]
      .filter((record) => record.provider === provider
        && record.status === "refund_pending"
        && record.processingStartedAt === null
        && record.attempts < MAX_REFUND_ATTEMPTS
        && (record.nextAttemptAt === null || new Date(record.nextAttemptAt).getTime() <= nowMs))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 100));
    return claimed.map((record) => {
      record.attempts += 1;
      record.processingStartedAt = now.toISOString();
      record.nextAttemptAt = null;
      return this.publicJob(record);
    });
  }

  async markSubmitted(id: string, attempt: number, submission: RefundSubmission): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.status !== "refund_pending" || !record.processingStartedAt || record.attempts !== attempt) return false;
    record.submittedAt ??= this.now().toISOString();
    record.providerRefundId ??= submission.providerRefundId;
    record.providerPayload = { ...record.providerPayload, ...submission.providerPayload };
    return true;
  }

  async markSucceeded(id: string, attempt: number, submission: RefundSubmission, status: GatewayRefundStatus): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.status === "refunded") return true;
    if (record.status !== "refund_pending" || !record.processingStartedAt || record.attempts !== attempt) return false;
    record.status = "refunded";
    record.providerRefundId = submission.providerRefundId;
    record.providerPayload = { ...record.providerPayload, ...submission.providerPayload, verification: status.providerPayload };
    record.processingStartedAt = null;
    record.nextAttemptAt = null;
    record.lastError = null;
    return true;
  }

  async markFailed(id: string, attempt: number, error: string, nextAttemptAt: string | null): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.status !== "refund_pending" || !record.processingStartedAt || record.attempts !== attempt) return;
    record.status = nextAttemptAt ? "refund_pending" : "failed";
    record.lastError = error;
    record.nextAttemptAt = nextAttemptAt;
    record.processingStartedAt = null;
  }

  async retry(id: string, _actorId: string, _actorRole: RefundActorRole): Promise<RefundRetryResult> {
    const record = this.records.get(id);
    if (!record) return { outcome: "not_found", status: null };
    if (record.status !== "failed") return { outcome: "state_conflict", status: record.status };
    record.status = "refund_pending";
    record.attempts = 0;
    record.processingStartedAt = null;
    record.nextAttemptAt = null;
    record.lastError = null;
    return { outcome: "updated", status: record.status };
  }

  private publicJob(record: MemoryRefundRecord): RefundJob {
    return {
      refundId: record.refundId,
      paymentId: record.paymentId,
      bookingId: record.bookingId,
      providerPaymentId: record.providerPaymentId,
      provider: record.provider,
      amount: record.amount,
      currency: "RUB",
      publicNumber: record.publicNumber,
      attempts: record.attempts,
      submittedAt: record.submittedAt,
      createdAt: record.createdAt,
    };
  }
}

interface RefundJobRow extends QueryResultRow {
  refund_id: string;
  payment_id: string;
  booking_id: string;
  provider_payment_id: string;
  provider: string;
  amount: string | number;
  currency: string;
  public_number: string;
  attempts: number;
  submitted_at: Date | string | null;
  created_at: Date | string;
}

function jobFromRow(row: RefundJobRow): RefundJob {
  return {
    refundId: row.refund_id,
    paymentId: row.payment_id,
    bookingId: row.booking_id,
    providerPaymentId: row.provider_payment_id,
    provider: row.provider as RefundJob["provider"],
    amount: Number(row.amount),
    currency: "RUB",
    publicNumber: row.public_number,
    attempts: Number(row.attempts),
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class PostgresRefundRepository implements RefundRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly pool: Pool) {}

  async claimBatch(provider: string, limit: number): Promise<RefundJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`update refunds
        set status = case when attempts >= $1 then 'failed'::payment_status else 'refund_pending'::payment_status end,
          processing_started_at = null,
          last_error = 'Предыдущая обработка возврата не завершилась.',
          updated_at = now()
        where status = 'refund_pending'
          and processing_started_at is not null
          and processing_started_at < now() - interval '10 minutes'`, [MAX_REFUND_ATTEMPTS]);
      const result = await client.query<RefundJobRow>(`-- rooms:claim-refunds
        with selected as (
          select refund.id, payment.id as payment_id, payment.booking_id, payment.provider_payment_id,
            payment.provider, refund.amount, payment.currency, booking.public_number,
            refund.submitted_at, refund.created_at
          from refunds refund
          join payment_transactions payment on payment.id = refund.payment_id
          join bookings booking on booking.id = payment.booking_id
          where payment.provider = $1
            and payment.provider_payment_id is not null
            and refund.status = 'refund_pending'
            and refund.processing_started_at is null
            and refund.attempts < $2
            and (refund.next_attempt_at is null or refund.next_attempt_at <= now())
          order by refund.created_at
          limit $3
          for update of refund skip locked
        )
        update refunds refund
        set attempts = refund.attempts + 1, processing_started_at = now(),
          next_attempt_at = null, updated_at = now()
        from selected
        where refund.id = selected.id
        returning refund.id::text as refund_id, selected.payment_id::text, selected.booking_id::text,
          selected.provider_payment_id, selected.provider, refund.amount,
          selected.currency, selected.public_number, refund.attempts,
          refund.submitted_at, refund.created_at`, [provider, MAX_REFUND_ATTEMPTS, Math.min(Math.max(limit, 1), 100)]);
      await client.query("commit");
      return result.rows.map(jobFromRow);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSubmitted(id: string, attempt: number, submission: RefundSubmission): Promise<boolean> {
    const result = await this.pool.query(`update refunds
      set provider_refund_id = coalesce(provider_refund_id, $3),
        submitted_at = coalesce(submitted_at, now()),
        provider_payload = provider_payload || $4::jsonb,
        updated_at = now()
      where id = $1::uuid and status = 'refund_pending'
        and processing_started_at is not null and attempts = $2`, [
      id,
      attempt,
      submission.providerRefundId,
      JSON.stringify(submission.providerPayload),
    ]);
    return result.rowCount === 1;
  }

  async markSucceeded(id: string, attempt: number, submission: RefundSubmission, status: GatewayRefundStatus): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{
        status: "refund_pending" | "refunded" | "failed";
        payment_id: string;
        booking_id: string;
        amount: string | number;
        attempts: number;
      }>(`select refund.status::text, refund.payment_id::text,
          payment.booking_id::text, refund.amount, refund.attempts
        from refunds refund
        join payment_transactions payment on payment.id = refund.payment_id
        where refund.id = $1::uuid
        for update of refund, payment`, [id]);
      const record = current.rows[0];
      if (!record) {
        await client.query("rollback");
        return false;
      }
      if (record.status === "refunded") {
        await client.query("commit");
        return true;
      }
      if (record.attempts !== attempt) {
        await client.query("rollback");
        return false;
      }
      const updated = await client.query(`update refunds
        set status = 'refunded', provider_refund_id = coalesce(provider_refund_id, $3),
          provider_payload = provider_payload || $4::jsonb,
          completed_at = now(), processing_started_at = null,
          next_attempt_at = null, last_error = null, updated_at = now()
        where id = $1::uuid and status = 'refund_pending'
          and processing_started_at is not null and attempts = $2`, [
        id,
        attempt,
        submission.providerRefundId,
        JSON.stringify({ ...submission.providerPayload, verification: status.providerPayload }),
      ]);
      if (updated.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }
      await client.query(`update payment_transactions
        set status = 'refunded', updated_at = now()
        where id = $1::uuid`, [record.payment_id]);
      await client.query(`insert into fiscal_receipts (
          payment_id, booking_id, receipt_type, status, amount, currency, items
        ) values (
          $1::uuid,$2::uuid,'refund','queued',$3,'RUB',
          jsonb_build_array(jsonb_build_object(
            'name','Возврат предоплаты по бронированию',
            'quantity',1,
            'price',$3::numeric,
            'amount',$3::numeric,
            'paymentObject','service',
            'paymentMethod','full_payment',
            'tax','none'
          ))
        ) on conflict (payment_id, receipt_type) do nothing`, [record.payment_id, record.booking_id, record.amount]);
      await client.query(`insert into audit_log (
          actor_id, actor_role, action, entity_type, entity_id, before_data, after_data
        ) values (null,null,'refund_completed_automatically','refund',$1,$2::jsonb,$3::jsonb)`, [
        id,
        JSON.stringify({ status: record.status, amount: Number(record.amount) }),
        JSON.stringify({ status: "refunded", amount: Number(record.amount), providerRefundId: submission.providerRefundId }),
      ]);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markFailed(id: string, attempt: number, error: string, nextAttemptAt: string | null): Promise<void> {
    await this.pool.query(`update refunds
      set status = case when $4::timestamptz is null then 'failed'::payment_status else 'refund_pending'::payment_status end,
        last_error = $3, next_attempt_at = $4::timestamptz,
        processing_started_at = null, updated_at = now()
      where id = $1::uuid and status = 'refund_pending'
        and processing_started_at is not null and attempts = $2`, [id, attempt, error, nextAttemptAt]);
  }

  async retry(id: string, actorId: string, actorRole: RefundActorRole): Promise<RefundRetryResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ status: "refund_pending" | "refunded" | "failed"; attempts: number }>(`
        select status::text, attempts from refunds where id = $1::uuid for update
      `, [id]);
      const record = current.rows[0];
      if (!record) {
        await client.query("rollback");
        return { outcome: "not_found", status: null };
      }
      if (record.status !== "failed") {
        await client.query("rollback");
        return { outcome: "state_conflict", status: record.status };
      }
      await client.query(`update refunds
        set status = 'refund_pending', attempts = 0, next_attempt_at = null,
          processing_started_at = null, last_error = null, updated_at = now()
        where id = $1::uuid`, [id]);
      await client.query(`insert into audit_log (
          actor_id, actor_role, action, entity_type, entity_id, before_data, after_data
        ) values ($1::uuid,$2::user_role,'refund_retried','refund',$3,$4::jsonb,$5::jsonb)`, [
        actorId,
        actorRole,
        id,
        JSON.stringify({ status: record.status, attempts: record.attempts }),
        JSON.stringify({ status: "refund_pending", attempts: 0 }),
      ]);
      await client.query("commit");
      return { outcome: "updated", status: "refund_pending" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

class RefundConfirmationPendingError extends Error {}

function safeRefundError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(authorization|password|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 500);
}

export interface RefundWorkerSummary {
  claimed: number;
  succeeded: number;
  failed: number;
}

export async function processRefundBatch(
  repository: RefundRepository,
  provider: PaymentGateway,
  limit = 20,
  now: () => Date = () => new Date(),
  onCompleted: (job: RefundJob) => Promise<void> = async () => undefined,
  onError: (error: unknown) => void = console.error,
): Promise<RefundWorkerSummary> {
  const jobs = await repository.claimBatch(provider.provider, limit);
  const summary: RefundWorkerSummary = { claimed: jobs.length, succeeded: 0, failed: 0 };
  for (const job of jobs) {
    try {
      if (!Number.isFinite(job.amount) || job.amount <= 0) {
        throw new PaymentGatewayError(400, "INVALID_REFUND_AMOUNT", "Сумма возврата должна быть положительной.", false);
      }
      let submission: RefundSubmission = {
        providerRefundId: `SBER-${job.refundId}`,
        providerPayload: {},
      };
      let verification = await provider.checkRefund(job);
      if (!verification.confirmed) {
        if (!job.submittedAt) {
          submission = await provider.submitRefund(job);
          const saved = await repository.markSubmitted(job.refundId, job.attempts, submission);
          if (!saved) throw new Error("Refund processing lease was lost after bank submission.");
        }
        verification = await provider.checkRefund(job);
      }
      if (!verification.confirmed) {
        throw new RefundConfirmationPendingError("Банк принял возврат, подтверждение операции ещё ожидается.");
      }
      const completed = await repository.markSucceeded(job.refundId, job.attempts, submission, verification);
      if (!completed) throw new Error("Refund processing lease was lost before completion.");
      summary.succeeded += 1;
      await onCompleted(job).catch(onError);
    } catch (error) {
      const retryable = !(error instanceof PaymentGatewayError) || error.retryable;
      const delaySeconds = Math.min(6 * 60 * 60, 60 * 5 ** Math.max(0, job.attempts - 1));
      const nextAttemptAt = retryable && job.attempts < MAX_REFUND_ATTEMPTS
        ? new Date(now().getTime() + delaySeconds * 1000).toISOString()
        : null;
      await repository.markFailed(job.refundId, job.attempts, safeRefundError(error), nextAttemptAt);
      summary.failed += 1;
    }
  }
  return summary;
}

export function startRefundWorker(
  repository: RefundRepository,
  provider: PaymentGateway,
  intervalMs = 5_000,
  batchSize = 20,
  onCompleted: (job: RefundJob) => Promise<void> = async () => undefined,
  onError: (error: unknown) => void = console.error,
): { stop(): void; runNow(): Promise<RefundWorkerSummary> } {
  let active = false;
  let stopped = false;
  const runNow = async () => {
    if (active || stopped) return { claimed: 0, succeeded: 0, failed: 0 };
    active = true;
    try {
      return await processRefundBatch(repository, provider, batchSize, () => new Date(), onCompleted, onError);
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

export function demoRefundSeed(overrides: Partial<MemoryRefundSeed> = {}): MemoryRefundSeed {
  const refundId = overrides.refundId ?? randomUUID();
  return {
    refundId,
    paymentId: overrides.paymentId ?? randomUUID(),
    bookingId: overrides.bookingId ?? randomUUID(),
    providerPaymentId: overrides.providerPaymentId ?? randomUUID(),
    provider: overrides.provider ?? "sber",
    amount: overrides.amount ?? 960,
    currency: "RUB",
    publicNumber: overrides.publicNumber ?? "RMS-REFUND-DEMO",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.attempts !== undefined ? { attempts: overrides.attempts } : {}),
    ...(overrides.submittedAt !== undefined ? { submittedAt: overrides.submittedAt } : {}),
    ...(overrides.processingStartedAt !== undefined ? { processingStartedAt: overrides.processingStartedAt } : {}),
    ...(overrides.nextAttemptAt !== undefined ? { nextAttemptAt: overrides.nextAttemptAt } : {}),
  };
}
