import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { BookingRecord, BookingRepository } from "./bookings.js";
import type { SupportRepository } from "./support.js";

export type FinanceActorRole = "admin" | "accountant";
export type FinanceRefundStatus = "refund_pending" | "refunded" | "failed";
export type FinanceRefundQueryStatus = FinanceRefundStatus | "all";
export type FinancePayoutStatus = "draft" | "sent" | "paid" | "cancelled";
export type FinancePayoutQueryStatus = FinancePayoutStatus | "all";
export type BankAccountQueryStatus = "pending" | "verified" | "all";
export type FiscalReceiptStatus = "queued" | "processing" | "succeeded" | "failed" | "cancelled";
export type FiscalReceiptQueryStatus = FiscalReceiptStatus | "all";
export type PayoutBlockedReason =
  | "bank_account_missing"
  | "bank_account_unverified"
  | "support_open"
  | "refund_pending"
  | "nothing_to_pay";

export interface BankAccountRecord {
  venueId: string;
  venueTitle: string;
  bankName: string | null;
  bik: string | null;
  accountLastFour: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
}

export interface BankAccountWrite {
  bankName: string;
  bik: string;
  settlementAccount: string;
}

export interface RefundRecord {
  id: string;
  paymentId: string;
  bookingId: string;
  publicNumber: string;
  venueId: string;
  venueTitle: string;
  clientName: string;
  amount: number;
  currency: "RUB";
  provider: string;
  status: FinanceRefundStatus;
  reason: string;
  providerRefundId: string | null;
  requestedBy: string | null;
  completedAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  processingStartedAt: string | null;
  submittedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface PayoutCandidateRecord {
  bookingId: string;
  publicNumber: string;
  venueId: string;
  venueTitle: string;
  startsAt: string;
  endsAt: string;
  prepayment: number;
  commission: number;
  amount: number;
  bankAccountVerified: boolean;
  accountLastFour: string | null;
  blockedReason: PayoutBlockedReason | null;
}

export interface PayoutItemRecord {
  bookingId: string;
  publicNumber: string;
  startsAt: string;
  prepayment: number;
  commission: number;
  amount: number;
}

export interface PayoutBatchRecord {
  id: string;
  venueId: string;
  venueTitle: string;
  status: FinancePayoutStatus;
  amount: number;
  scheduledFor: string | null;
  sentAt: string | null;
  paidAt: string | null;
  providerPayoutId: string | null;
  accountLastFour: string | null;
  createdBy: string | null;
  createdAt: string;
  items: PayoutItemRecord[];
}

export interface FiscalReceiptRecord {
  id: string;
  paymentId: string;
  bookingId: string;
  publicNumber: string;
  venueTitle: string;
  receiptType: "sale" | "refund";
  status: FiscalReceiptStatus;
  amount: number;
  currency: "RUB";
  provider: string | null;
  providerReceiptId: string | null;
  fiscalDocumentNumber: string | null;
  fiscalSign: string | null;
  receiptUrl: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceOverview {
  expected: number;
  ready: number;
  sent: number;
  paid: number;
  refundPending: number;
  refunded: number;
  candidateCount: number;
  readyCount: number;
  refundPendingCount: number;
}

export interface FinanceRepository {
  readonly storage: "memory" | "postgresql";
  getPartnerBankAccount(partnerId: string): Promise<BankAccountRecord | null>;
  updatePartnerBankAccount(partnerId: string, input: BankAccountWrite): Promise<BankAccountRecord | null>;
  listBankAccounts(status: BankAccountQueryStatus, limit: number): Promise<BankAccountRecord[]>;
  verifyBankAccount(actorId: string, actorRole: FinanceActorRole, venueId: string): Promise<BankAccountRecord | null>;
  listReceipts(status: FiscalReceiptQueryStatus, limit: number): Promise<FiscalReceiptRecord[]>;
  listRefunds(status: FinanceRefundQueryStatus, limit: number): Promise<RefundRecord[]>;
  completeRefund(actorId: string, actorRole: FinanceActorRole, refundId: string, providerRefundId?: string): Promise<RefundRecord | null>;
  listPayoutCandidates(): Promise<PayoutCandidateRecord[]>;
  listPayouts(actorId: string, actorRole: FinanceActorRole | "partner", status: FinancePayoutQueryStatus, limit: number): Promise<PayoutBatchRecord[]>;
  createPayouts(actorId: string, actorRole: FinanceActorRole, bookingIds?: string[], scheduledFor?: string): Promise<PayoutBatchRecord[]>;
  completePayout(actorId: string, actorRole: FinanceActorRole, payoutId: string, providerPayoutId?: string): Promise<PayoutBatchRecord | null>;
  overview(): Promise<FinanceOverview>;
}

export class FinanceActionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export class FinanceCipher {
  private readonly key: Buffer;
  private readonly associatedData = Buffer.from("rooms-finance-v1", "utf8");

  constructor(secret: string) {
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("FINANCE_ENCRYPTION_KEY must contain at least 32 bytes.");
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.associatedData);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
  }

  decrypt(value: string): string {
    const [prefix, version, ivValue, tagValue, encryptedValue] = value.split(":");
    if (prefix !== "enc" || version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
      throw new Error("Bank account data is unavailable.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(this.associatedData);
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
  }
}

function amount(value: string | number): number {
  return Number(Number(value).toFixed(2));
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nextMonday(): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  const days = (8 - date.getUTCDay()) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function settlementForBooking(booking: BookingRecord): { prepayment: number; commission: number; amount: number } {
  const commission = Math.ceil(booking.money.total * 0.15);
  return {
    prepayment: booking.money.prepayment,
    commission,
    amount: Math.max(0, booking.money.prepayment - commission),
  };
}

interface MemoryBankAccount extends BankAccountRecord {
  encryptedAccount: string;
}

export class MemoryFinanceRepository implements FinanceRepository {
  readonly storage = "memory" as const;
  private readonly bankAccounts = new Map<string, MemoryBankAccount>();
  private readonly refunds = new Map<string, RefundRecord>();
  private readonly payouts = new Map<string, PayoutBatchRecord>();

  constructor(
    private readonly bookings: BookingRepository,
    private readonly support: SupportRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getPartnerBankAccount(partnerId: string): Promise<BankAccountRecord | null> {
    const venue = await this.bookings.getPartnerVenue(partnerId);
    if (!venue) return null;
    const record = this.bankAccounts.get(venue.id);
    return record ? this.publicBank(record) : {
      venueId: venue.id,
      venueTitle: venue.title,
      bankName: null,
      bik: null,
      accountLastFour: null,
      verifiedAt: null,
      updatedAt: null,
    };
  }

  async updatePartnerBankAccount(partnerId: string, input: BankAccountWrite): Promise<BankAccountRecord | null> {
    const venue = await this.bookings.getPartnerVenue(partnerId);
    if (!venue) return null;
    const updatedAt = this.now().toISOString();
    const record: MemoryBankAccount = {
      venueId: venue.id,
      venueTitle: venue.title,
      bankName: input.bankName.trim(),
      bik: input.bik,
      accountLastFour: input.settlementAccount.slice(-4),
      verifiedAt: null,
      updatedAt,
      encryptedAccount: `memory:${input.settlementAccount}`,
    };
    this.bankAccounts.set(venue.id, record);
    return this.publicBank(record);
  }

  async listBankAccounts(status: BankAccountQueryStatus, limit: number): Promise<BankAccountRecord[]> {
    return [...this.bankAccounts.values()]
      .filter((record) => status === "all" || (status === "verified") === Boolean(record.verifiedAt))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, limit)
      .map((record) => this.publicBank(record));
  }

  async verifyBankAccount(_actorId: string, _actorRole: FinanceActorRole, venueId: string): Promise<BankAccountRecord | null> {
    const record = this.bankAccounts.get(venueId);
    if (!record) return null;
    record.verifiedAt = this.now().toISOString();
    record.updatedAt = record.verifiedAt;
    return this.publicBank(record);
  }

  async listReceipts(): Promise<FiscalReceiptRecord[]> {
    return [];
  }

  async listRefunds(status: FinanceRefundQueryStatus, limit: number): Promise<RefundRecord[]> {
    await this.syncRefunds();
    return [...this.refunds.values()]
      .filter((record) => status === "all" || record.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async completeRefund(_actorId: string, _actorRole: FinanceActorRole, refundId: string, providerRefundId?: string): Promise<RefundRecord | null> {
    await this.syncRefunds();
    const refund = this.refunds.get(refundId);
    if (!refund) return null;
    if (refund.status === "refunded") return structuredClone(refund);
    if (refund.status !== "refund_pending") throw new FinanceActionError(409, "REFUND_STATE_CHANGED", "Возврат уже обработан.");
    if (refund.provider !== "rooms_demo") {
      throw new FinanceActionError(409, "AUTOMATIC_REFUND_REQUIRED", "Банковский возврат выполняется автоматически.");
    }
    refund.status = "refunded";
    refund.providerRefundId = providerRefundId?.trim() || `ROOMS-DEMO-REFUND-${randomUUID()}`;
    refund.completedAt = this.now().toISOString();
    return structuredClone(refund);
  }

  async listPayoutCandidates(): Promise<PayoutCandidateRecord[]> {
    await this.syncRefunds();
    const bookings = await this.bookings.listByAdmin("all");
    const support = await this.support.list("00000000-0000-4000-8000-000000000001", "admin", "all", 500);
    const activeSupport = new Set(support.filter((record) => record.status !== "closed").map((record) => record.bookingId));
    const paidOut = new Set([...this.payouts.values()].filter((batch) => batch.status !== "cancelled").flatMap((batch) => batch.items.map((item) => item.bookingId)));
    return bookings
      .filter((booking) => ["visited", "completed"].includes(booking.status) && booking.paymentStatus === "paid" && !paidOut.has(booking.id))
      .map((booking) => {
        const settlement = settlementForBooking(booking);
        const bank = this.bankAccounts.get(booking.venue.id);
        const refund = [...this.refunds.values()].find((record) => record.bookingId === booking.id && record.status !== "failed");
        const blockedReason: PayoutBlockedReason | null = refund
          ? "refund_pending"
          : activeSupport.has(booking.id)
            ? "support_open"
            : !bank
              ? "bank_account_missing"
              : !bank.verifiedAt
                ? "bank_account_unverified"
                : settlement.amount <= 0
                  ? "nothing_to_pay"
                  : null;
        return {
          bookingId: booking.id,
          publicNumber: booking.publicNumber,
          venueId: booking.venue.id,
          venueTitle: booking.venue.title,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          ...settlement,
          bankAccountVerified: Boolean(bank?.verifiedAt),
          accountLastFour: bank?.accountLastFour ?? null,
          blockedReason,
        };
      })
      .sort((left, right) => left.endsAt.localeCompare(right.endsAt));
  }

  async listPayouts(actorId: string, actorRole: FinanceActorRole | "partner", status: FinancePayoutQueryStatus, limit: number): Promise<PayoutBatchRecord[]> {
    const venue = actorRole === "partner" ? await this.bookings.getPartnerVenue(actorId) : null;
    return [...this.payouts.values()]
      .filter((batch) => (!venue || batch.venueId === venue.id) && (status === "all" || batch.status === status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((batch) => structuredClone(batch));
  }

  async createPayouts(actorId: string, _actorRole: FinanceActorRole, bookingIds?: string[], scheduledFor = nextMonday()): Promise<PayoutBatchRecord[]> {
    const candidates = await this.listPayoutCandidates();
    const requested = bookingIds?.length ? new Set(bookingIds) : null;
    const selected = candidates.filter((candidate) => (!requested || requested.has(candidate.bookingId)) && !candidate.blockedReason);
    if (requested && (selected.length !== requested.size || candidates.some((candidate) => requested.has(candidate.bookingId) && candidate.blockedReason))) {
      throw new FinanceActionError(409, "PAYOUT_NOT_ELIGIBLE", "Одна из выбранных броней ещё не готова к выплате.");
    }
    if (!selected.length) return [];
    const groups = new Map<string, PayoutCandidateRecord[]>();
    for (const candidate of selected) groups.set(candidate.venueId, [...(groups.get(candidate.venueId) ?? []), candidate]);
    const created: PayoutBatchRecord[] = [];
    for (const [venueId, items] of groups) {
      const timestamp = this.now().toISOString();
      const batch: PayoutBatchRecord = {
        id: randomUUID(),
        venueId,
        venueTitle: items[0]!.venueTitle,
        status: "sent",
        amount: amount(items.reduce((sum, item) => sum + item.amount, 0)),
        scheduledFor,
        sentAt: timestamp,
        paidAt: null,
        providerPayoutId: null,
        accountLastFour: items[0]!.accountLastFour,
        createdBy: actorId,
        createdAt: timestamp,
        items: items.map((item) => ({
          bookingId: item.bookingId,
          publicNumber: item.publicNumber,
          startsAt: item.startsAt,
          prepayment: item.prepayment,
          commission: item.commission,
          amount: item.amount,
        })),
      };
      this.payouts.set(batch.id, batch);
      created.push(structuredClone(batch));
    }
    return created;
  }

  async completePayout(_actorId: string, _actorRole: FinanceActorRole, payoutId: string, providerPayoutId?: string): Promise<PayoutBatchRecord | null> {
    const payout = this.payouts.get(payoutId);
    if (!payout) return null;
    if (payout.status === "paid") return structuredClone(payout);
    if (payout.status !== "sent") throw new FinanceActionError(409, "PAYOUT_STATE_CHANGED", "Эту выплату сейчас нельзя завершить.");
    payout.status = "paid";
    payout.paidAt = this.now().toISOString();
    payout.providerPayoutId = providerPayoutId?.trim() || `ROOMS-DEMO-PAYOUT-${randomUUID()}`;
    return structuredClone(payout);
  }

  async overview(): Promise<FinanceOverview> {
    const [candidates, payouts, refunds] = await Promise.all([
      this.listPayoutCandidates(),
      this.listPayouts("00000000-0000-4000-8000-000000000001", "admin", "all", 1000),
      this.listRefunds("all", 1000),
    ]);
    return overviewFrom(candidates, payouts, refunds);
  }

  private async syncRefunds(): Promise<void> {
    const bookings = await this.bookings.listByAdmin("all");
    for (const booking of bookings) {
      if (!booking.cancellationReason || !["refund_pending", "refunded"].includes(booking.paymentStatus)) continue;
      const existing = [...this.refunds.values()].find((record) => record.bookingId === booking.id);
      if (existing) continue;
      this.refunds.set(booking.id, {
        id: booking.id,
        paymentId: `memory-payment-${booking.id}`,
        bookingId: booking.id,
        publicNumber: booking.publicNumber,
        venueId: booking.venue.id,
        venueTitle: booking.venue.title,
        clientName: booking.clientName,
        amount: booking.money.prepayment,
        currency: "RUB",
        provider: "rooms_demo",
        status: booking.paymentStatus as FinanceRefundStatus,
        reason: booking.cancellationReason,
        providerRefundId: null,
        requestedBy: null,
        completedAt: null,
        attempts: 0,
        nextAttemptAt: null,
        processingStartedAt: null,
        submittedAt: null,
        lastError: null,
        createdAt: this.now().toISOString(),
      });
    }
  }

  private publicBank(record: MemoryBankAccount): BankAccountRecord {
    const { encryptedAccount: _encryptedAccount, ...safe } = record;
    return structuredClone(safe);
  }
}

interface BankAccountRow extends QueryResultRow {
  venue_id: string;
  venue_title: string;
  bank_name: string | null;
  bik: string | null;
  account_last_four: string | null;
  verified_at: Date | string | null;
  updated_at: Date | string | null;
}

interface RefundRow extends QueryResultRow {
  id: string;
  payment_id: string;
  booking_id: string;
  public_number: string;
  venue_id: string;
  venue_title: string;
  client_name: string;
  amount: string | number;
  currency: string;
  provider: string;
  status: FinanceRefundStatus;
  reason: string | null;
  provider_refund_id: string | null;
  requested_by: string | null;
  completed_at: Date | string | null;
  attempts: number;
  next_attempt_at: Date | string | null;
  processing_started_at: Date | string | null;
  submitted_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
}

interface FiscalReceiptRow extends QueryResultRow {
  id: string;
  payment_id: string;
  booking_id: string;
  public_number: string;
  venue_title: string;
  receipt_type: "sale" | "refund";
  status: FiscalReceiptStatus;
  amount: string | number;
  currency: string;
  provider: string | null;
  provider_receipt_id: string | null;
  fiscal_document_number: string | null;
  fiscal_sign: string | null;
  receipt_url: string | null;
  attempts: number;
  next_attempt_at: Date | string | null;
  last_error: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CandidateRow extends QueryResultRow {
  booking_id: string;
  public_number: string;
  venue_id: string;
  venue_title: string;
  starts_at: Date | string;
  ends_at: Date | string;
  prepayment: string | number;
  commission: string | number;
  payout_amount: string | number;
  account_last_four: string | null;
  bank_account_exists: boolean;
  bank_account_verified: boolean;
  support_open: boolean;
  refund_open: boolean;
}

interface PayoutBatchRow extends QueryResultRow {
  id: string;
  venue_id: string;
  venue_title: string;
  status: FinancePayoutStatus;
  amount: string | number;
  scheduled_for: Date | string | null;
  sent_at: Date | string | null;
  paid_at: Date | string | null;
  provider_payout_id: string | null;
  account_last_four: string | null;
  created_by: string | null;
  created_at: Date | string;
}

interface PayoutDestinationRow extends QueryResultRow {
  bank_name: string;
  bik: string;
  destination_account_ciphertext: string;
  account_last_four: string;
}

interface PayoutItemRow extends QueryResultRow {
  payout_id: string;
  booking_id: string;
  public_number: string;
  starts_at: Date | string;
  prepayment: string | number;
  commission: string | number;
  amount: string | number;
}

const BANK_ACCOUNT_SELECT = `
  select venue.id::text as venue_id, venue.title as venue_title,
    bank.bank_name, bank.bik, bank.account_last_four,
    bank.verified_at, bank.updated_at
  from venues venue
  left join venue_bank_accounts bank on bank.venue_id = venue.id
`;

const REFUND_SELECT = `
  select refund.id::text, refund.payment_id::text, payment.booking_id::text,
    booking.public_number, venue.id::text as venue_id, venue.title as venue_title,
    booking.client_name, refund.amount, payment.currency, payment.provider,
    refund.status, refund.reason, refund.provider_refund_id,
    refund.requested_by::text, refund.completed_at, refund.attempts,
    refund.next_attempt_at, refund.processing_started_at, refund.submitted_at,
    refund.last_error, refund.created_at
  from refunds refund
  join payment_transactions payment on payment.id = refund.payment_id
  join bookings booking on booking.id = payment.booking_id
  join venues venue on venue.id = booking.venue_id
`;

const RECEIPT_SELECT = `
  select receipt.id::text, receipt.payment_id::text, receipt.booking_id::text,
    booking.public_number, venue.title as venue_title,
    receipt.receipt_type, receipt.status, receipt.amount, receipt.currency,
    receipt.provider, receipt.provider_receipt_id, receipt.fiscal_document_number,
    receipt.fiscal_sign, receipt.receipt_url, receipt.attempts, receipt.next_attempt_at, receipt.last_error,
    receipt.completed_at, receipt.created_at, receipt.updated_at
  from fiscal_receipts receipt
  join bookings booking on booking.id = receipt.booking_id
  join venues venue on venue.id = booking.venue_id
`;

const CANDIDATE_SELECT = `
  select booking.id::text as booking_id, booking.public_number,
    venue.id::text as venue_id, venue.title as venue_title,
    booking.starts_at, booking.ends_at, booking.prepayment, booking.commission,
    greatest(0, booking.prepayment - booking.commission) as payout_amount,
    bank.account_last_four,
    (bank.venue_id is not null and bank.settlement_account_ciphertext is not null and bank.account_last_four is not null) as bank_account_exists,
    (bank.verified_at is not null and bank.settlement_account_ciphertext is not null and bank.account_last_four is not null) as bank_account_verified,
    exists (
      select 1 from booking_support_cases support_case
      where support_case.booking_id = booking.id and support_case.status <> 'closed'
    ) as support_open,
    exists (
      select 1 from refunds refund
      join payment_transactions refund_payment on refund_payment.id = refund.payment_id
      where refund_payment.booking_id = booking.id and refund.status in ('refund_pending','refunded','failed')
    ) as refund_open
  from bookings booking
  join venues venue on venue.id = booking.venue_id
  left join venue_bank_accounts bank on bank.venue_id = venue.id
  where booking.status in ('visited','completed')
    and exists (
      select 1 from payment_transactions payment
      where payment.booking_id = booking.id and payment.status = 'paid'
    )
    and not exists (
      select 1 from payout_items payout_item where payout_item.booking_id = booking.id
    )
`;

function bankFromRow(row: BankAccountRow): BankAccountRecord {
  return {
    venueId: row.venue_id,
    venueTitle: row.venue_title,
    bankName: row.bank_name,
    bik: row.bik,
    accountLastFour: row.account_last_four?.trim() || null,
    verifiedAt: iso(row.verified_at),
    updatedAt: iso(row.updated_at),
  };
}

function refundFromRow(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    paymentId: row.payment_id,
    bookingId: row.booking_id,
    publicNumber: row.public_number,
    venueId: row.venue_id,
    venueTitle: row.venue_title,
    clientName: row.client_name,
    amount: amount(row.amount),
    currency: "RUB",
    provider: row.provider,
    status: row.status,
    reason: row.reason ?? "Возврат после отмены брони",
    providerRefundId: row.provider_refund_id,
    requestedBy: row.requested_by,
    completedAt: iso(row.completed_at),
    attempts: Number(row.attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    processingStartedAt: iso(row.processing_started_at),
    submittedAt: iso(row.submitted_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at)!,
  };
}

function receiptFromRow(row: FiscalReceiptRow): FiscalReceiptRecord {
  return {
    id: row.id,
    paymentId: row.payment_id,
    bookingId: row.booking_id,
    publicNumber: row.public_number,
    venueTitle: row.venue_title,
    receiptType: row.receipt_type,
    status: row.status,
    amount: amount(row.amount),
    currency: "RUB",
    provider: row.provider,
    providerReceiptId: row.provider_receipt_id,
    fiscalDocumentNumber: row.fiscal_document_number,
    fiscalSign: row.fiscal_sign,
    receiptUrl: row.receipt_url,
    attempts: Number(row.attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    lastError: row.last_error,
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function candidateFromRow(row: CandidateRow): PayoutCandidateRecord {
  const payoutAmount = amount(row.payout_amount);
  const blockedReason: PayoutBlockedReason | null = row.refund_open
    ? "refund_pending"
    : row.support_open
      ? "support_open"
      : !row.bank_account_exists
        ? "bank_account_missing"
        : !row.bank_account_verified
          ? "bank_account_unverified"
          : payoutAmount <= 0
            ? "nothing_to_pay"
            : null;
  return {
    bookingId: row.booking_id,
    publicNumber: row.public_number,
    venueId: row.venue_id,
    venueTitle: row.venue_title,
    startsAt: iso(row.starts_at)!,
    endsAt: iso(row.ends_at)!,
    prepayment: amount(row.prepayment),
    commission: amount(row.commission),
    amount: payoutAmount,
    bankAccountVerified: row.bank_account_verified,
    accountLastFour: row.account_last_four?.trim() || null,
    blockedReason,
  };
}

function overviewFrom(candidates: PayoutCandidateRecord[], payouts: PayoutBatchRecord[], refunds: RefundRecord[]): FinanceOverview {
  const openCandidates = candidates.filter((candidate) => candidate.blockedReason !== "refund_pending");
  return {
    expected: amount(openCandidates.reduce((sum, candidate) => sum + candidate.amount, 0)),
    ready: amount(openCandidates.filter((candidate) => candidate.blockedReason === null).reduce((sum, candidate) => sum + candidate.amount, 0)),
    sent: amount(payouts.filter((batch) => batch.status === "sent").reduce((sum, batch) => sum + batch.amount, 0)),
    paid: amount(payouts.filter((batch) => batch.status === "paid").reduce((sum, batch) => sum + batch.amount, 0)),
    refundPending: amount(refunds.filter((refund) => refund.status !== "refunded").reduce((sum, refund) => sum + refund.amount, 0)),
    refunded: amount(refunds.filter((refund) => refund.status === "refunded").reduce((sum, refund) => sum + refund.amount, 0)),
    candidateCount: openCandidates.length,
    readyCount: openCandidates.filter((candidate) => candidate.blockedReason === null).length,
    refundPendingCount: refunds.filter((refund) => refund.status !== "refunded").length,
  };
}

export class PostgresFinanceRepository implements FinanceRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly pool: Pool, private readonly cipher: FinanceCipher) {}

  async getPartnerBankAccount(partnerId: string): Promise<BankAccountRecord | null> {
    const result = await this.pool.query<BankAccountRow>(`${BANK_ACCOUNT_SELECT}
      join venue_members member on member.venue_id = venue.id
      where member.user_id = $1::uuid
      order by member.created_at
      limit 1
    `, [partnerId]);
    return result.rows[0] ? bankFromRow(result.rows[0]) : null;
  }

  async updatePartnerBankAccount(partnerId: string, input: BankAccountWrite): Promise<BankAccountRecord | null> {
    const client = await this.pool.connect();
    let venueId = "";
    try {
      await client.query("begin");
      const venue = await client.query<{ id: string; title: string }>(`
        select venue.id::text, venue.title
        from venues venue
        join venue_members member on member.venue_id = venue.id
        where member.user_id = $1::uuid
        order by member.created_at
        limit 1
        for update of venue
      `, [partnerId]);
      if (!venue.rows[0]) {
        await client.query("rollback");
        return null;
      }
      venueId = venue.rows[0].id;
      const before = await client.query<{ bank_name: string; bik: string; account_last_four: string; verified_at: Date | string | null }>(`
        select bank_name, bik, account_last_four, verified_at
        from venue_bank_accounts where venue_id = $1::uuid
        for update
      `, [venueId]);
      await client.query(`insert into venue_bank_accounts (
        venue_id, bank_name, bik, settlement_account_ciphertext, account_last_four,
        verified_at, updated_by, updated_at
      ) values ($1::uuid,$2,$3,$4,$5,null,$6::uuid,now())
      on conflict (venue_id) do update set
        bank_name = excluded.bank_name,
        bik = excluded.bik,
        settlement_account_ciphertext = excluded.settlement_account_ciphertext,
        account_last_four = excluded.account_last_four,
        verified_at = null,
        updated_by = excluded.updated_by,
        updated_at = now()
      `, [venueId, input.bankName.trim(), input.bik, this.cipher.encrypt(input.settlementAccount), input.settlementAccount.slice(-4), partnerId]);
      await this.audit(client, partnerId, "partner", "bank_account_updated", "venue_bank_account", venueId, {
        exists: Boolean(before.rows[0]),
        bankName: before.rows[0]?.bank_name ?? null,
        bik: before.rows[0]?.bik ?? null,
        accountLastFour: before.rows[0]?.account_last_four?.trim() ?? null,
        verified: Boolean(before.rows[0]?.verified_at),
      }, {
        exists: true,
        bankName: input.bankName.trim(),
        bik: input.bik,
        accountLastFour: input.settlementAccount.slice(-4),
        verified: false,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const result = await this.pool.query<BankAccountRow>(`${BANK_ACCOUNT_SELECT} where venue.id = $1::uuid`, [venueId]);
    return result.rows[0] ? bankFromRow(result.rows[0]) : null;
  }

  async listBankAccounts(status: BankAccountQueryStatus, limit: number): Promise<BankAccountRecord[]> {
    const result = await this.pool.query<BankAccountRow>(`${BANK_ACCOUNT_SELECT}
      where bank.venue_id is not null
        and ($1::text = 'all'
          or ($1::text = 'verified' and bank.verified_at is not null)
          or ($1::text = 'pending' and bank.verified_at is null))
      order by bank.verified_at nulls first, bank.updated_at desc
      limit $2
    `, [status, limit]);
    return result.rows.map(bankFromRow);
  }

  async verifyBankAccount(actorId: string, actorRole: FinanceActorRole, venueId: string): Promise<BankAccountRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ verified_at: Date | string | null }>(`
        select verified_at from venue_bank_accounts where venue_id = $1::uuid for update
      `, [venueId]);
      if (!current.rows[0]) {
        await client.query("rollback");
        return null;
      }
      if (!current.rows[0].verified_at) {
        await client.query(`update venue_bank_accounts
          set verified_at = now(), updated_by = $2::uuid, updated_at = now()
          where venue_id = $1::uuid`, [venueId, actorId]);
        await this.audit(client, actorId, actorRole, "bank_account_verified", "venue_bank_account", venueId,
          { verified: false }, { verified: true });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const result = await this.pool.query<BankAccountRow>(`${BANK_ACCOUNT_SELECT} where venue.id = $1::uuid`, [venueId]);
    return result.rows[0] ? bankFromRow(result.rows[0]) : null;
  }

  async listRefunds(status: FinanceRefundQueryStatus, limit: number): Promise<RefundRecord[]> {
    const result = await this.pool.query<RefundRow>(`${REFUND_SELECT}
      where ($1::text = 'all' or refund.status::text = $1::text)
      order by case refund.status when 'refund_pending' then 0 when 'failed' then 1 else 2 end, refund.created_at
      limit $2
    `, [status, limit]);
    return result.rows.map(refundFromRow);
  }

  async listReceipts(status: FiscalReceiptQueryStatus, limit: number): Promise<FiscalReceiptRecord[]> {
    const values: unknown[] = [];
    const where = status === "all" ? "" : `where receipt.status = $1`;
    if (status !== "all") values.push(status);
    values.push(Math.min(Math.max(limit, 1), 200));
    const result = await this.pool.query<FiscalReceiptRow>(`
      ${RECEIPT_SELECT}
      ${where}
      order by receipt.created_at desc
      limit $${values.length}
    `, values);
    return result.rows.map(receiptFromRow);
  }

  async completeRefund(actorId: string, actorRole: FinanceActorRole, refundId: string, providerRefundId?: string): Promise<RefundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<RefundRow>(`${REFUND_SELECT}
        where refund.id = $1::uuid
        for update of refund, payment
      `, [refundId]);
      const refund = current.rows[0];
      if (!refund) {
        await client.query("rollback");
        return null;
      }
      if (refund.status !== "refunded") {
        if (refund.status !== "refund_pending") throw new FinanceActionError(409, "REFUND_STATE_CHANGED", "Возврат уже обработан.");
        if (refund.provider !== "rooms_demo") {
          throw new FinanceActionError(409, "AUTOMATIC_REFUND_REQUIRED", "Банковский возврат выполняется автоматически.");
        }
        const providerId = providerRefundId?.trim() || `ROOMS-DEMO-REFUND-${randomUUID()}`;
        await client.query(`update refunds
          set status = 'refunded', provider_refund_id = $2, completed_at = now(),
            processing_started_at = null, next_attempt_at = null, last_error = null, updated_at = now()
          where id = $1::uuid`, [refundId, providerId]);
        await client.query(`update payment_transactions
          set status = 'refunded', updated_at = now()
          where id = $1::uuid`, [refund.payment_id]);
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
          ) on conflict (payment_id, receipt_type) do nothing`, [refund.payment_id, refund.booking_id, refund.amount]);
        await this.audit(client, actorId, actorRole, "refund_completed", "refund", refundId,
          { status: refund.status, amount: amount(refund.amount) },
          { status: "refunded", amount: amount(refund.amount), providerRefundId: providerId });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findRefund(refundId);
  }

  async listPayoutCandidates(): Promise<PayoutCandidateRecord[]> {
    const result = await this.pool.query<CandidateRow>(`${CANDIDATE_SELECT} order by booking.ends_at, booking.id`);
    return result.rows.map(candidateFromRow);
  }

  async listPayouts(actorId: string, actorRole: FinanceActorRole | "partner", status: FinancePayoutQueryStatus, limit: number): Promise<PayoutBatchRecord[]> {
    const result = await this.pool.query<PayoutBatchRow>(`
      select payout.id::text, payout.venue_id::text, venue.title as venue_title,
        payout.status, payout.amount, payout.scheduled_for, payout.sent_at, payout.paid_at,
        payout.provider_payout_id, payout.account_last_four,
        payout.created_by::text, payout.created_at
      from payout_batches payout
      join venues venue on venue.id = payout.venue_id
      where ($3::text = 'all' or payout.status::text = $3::text)
        and ($2::text <> 'partner' or exists (
          select 1 from venue_members member
          where member.venue_id = payout.venue_id and member.user_id = $1::uuid
        ))
      order by payout.created_at desc
      limit $4
    `, [actorId, actorRole, status, limit]);
    return this.hydratePayouts(result.rows);
  }

  async createPayouts(actorId: string, actorRole: FinanceActorRole, bookingIds?: string[], scheduledFor = nextMonday()): Promise<PayoutBatchRecord[]> {
    const client = await this.pool.connect();
    const payoutIds: string[] = [];
    try {
      await client.query("begin");
      const selectedIds = bookingIds?.length ? bookingIds : null;
      const result = await client.query<CandidateRow>(`${CANDIDATE_SELECT}
        and ($1::uuid[] is null or booking.id = any($1::uuid[]))
        order by booking.venue_id, booking.id
        for update of booking
      `, [selectedIds]);
      const foundCandidates = result.rows.map(candidateFromRow);
      if (selectedIds && (new Set(foundCandidates.map((candidate) => candidate.bookingId)).size !== new Set(selectedIds).size)) {
        throw new FinanceActionError(409, "PAYOUT_NOT_ELIGIBLE", "Одна из выбранных броней ещё не готова к выплате.");
      }
      if (selectedIds && foundCandidates.some((candidate) => candidate.blockedReason)) {
        throw new FinanceActionError(409, "PAYOUT_NOT_ELIGIBLE", "У выплаты есть незакрытое обращение, возврат или непроверенные реквизиты.");
      }
      const candidates = selectedIds ? foundCandidates : foundCandidates.filter((candidate) => !candidate.blockedReason);
      if (!candidates.length) {
        await client.query("commit");
        return [];
      }
      const groups = new Map<string, PayoutCandidateRecord[]>();
      for (const candidate of candidates) groups.set(candidate.venueId, [...(groups.get(candidate.venueId) ?? []), candidate]);
      for (const [venueId, items] of groups) {
        const destinationResult = await client.query<PayoutDestinationRow>(`
          select bank_name, bik,
            settlement_account_ciphertext as destination_account_ciphertext,
            account_last_four
          from venue_bank_accounts
          where venue_id = $1::uuid
            and verified_at is not null
            and settlement_account_ciphertext is not null
            and account_last_four is not null
          for share
        `, [venueId]);
        const destination = destinationResult.rows[0];
        if (!destination) {
          throw new FinanceActionError(409, "PAYOUT_DESTINATION_CHANGED", "Реквизиты площадки изменились или требуют повторной проверки.");
        }
        const payoutId = randomUUID();
        const total = amount(items.reduce((sum, item) => sum + item.amount, 0));
        await client.query(`insert into payout_batches (
          id, venue_id, status, amount, scheduled_for, sent_at, created_by,
          bank_name, bik, destination_account_ciphertext, account_last_four,
          created_at, updated_at
        ) values ($1::uuid,$2::uuid,'sent',$3,$4::date,now(),$5::uuid,$6,$7,$8,$9,now(),now())`, [
          payoutId, venueId, total, scheduledFor, actorId,
          destination.bank_name, destination.bik, destination.destination_account_ciphertext, destination.account_last_four,
        ]);
        for (const item of items) {
          await client.query(`insert into payout_items (payout_id, booking_id, amount)
            values ($1::uuid,$2::uuid,$3)`, [payoutId, item.bookingId, item.amount]);
        }
        await this.audit(client, actorId, actorRole, "payout_sent", "payout_batch", payoutId,
          null, { venueId, amount: total, bookingIds: items.map((item) => item.bookingId), scheduledFor, accountLastFour: destination.account_last_four.trim() });
        payoutIds.push(payoutId);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") {
        throw new FinanceActionError(409, "PAYOUT_STATE_CHANGED", "Одна из броней уже попала в другую выплату.");
      }
      throw error;
    } finally {
      client.release();
    }
    return this.findPayouts(payoutIds);
  }

  async completePayout(actorId: string, actorRole: FinanceActorRole, payoutId: string, providerPayoutId?: string): Promise<PayoutBatchRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ status: FinancePayoutStatus; amount: string | number }>(`
        select status, amount from payout_batches where id = $1::uuid for update
      `, [payoutId]);
      const payout = current.rows[0];
      if (!payout) {
        await client.query("rollback");
        return null;
      }
      if (payout.status !== "paid") {
        if (payout.status !== "sent") throw new FinanceActionError(409, "PAYOUT_STATE_CHANGED", "Эту выплату сейчас нельзя завершить.");
        const providerId = providerPayoutId?.trim() || `ROOMS-DEMO-PAYOUT-${randomUUID()}`;
        await client.query(`update payout_batches
          set status = 'paid', provider_payout_id = $2, paid_at = now(), updated_at = now()
          where id = $1::uuid`, [payoutId, providerId]);
        await this.audit(client, actorId, actorRole, "payout_completed", "payout_batch", payoutId,
          { status: payout.status, amount: amount(payout.amount) },
          { status: "paid", amount: amount(payout.amount), providerPayoutId: providerId });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return (await this.findPayouts([payoutId]))[0] ?? null;
  }

  async overview(): Promise<FinanceOverview> {
    const [candidates, payouts, refunds] = await Promise.all([
      this.listPayoutCandidates(),
      this.listPayouts("00000000-0000-4000-8000-000000000001", "admin", "all", 1000),
      this.listRefunds("all", 1000),
    ]);
    return overviewFrom(candidates, payouts, refunds);
  }

  private async findRefund(refundId: string): Promise<RefundRecord | null> {
    const result = await this.pool.query<RefundRow>(`${REFUND_SELECT} where refund.id = $1::uuid`, [refundId]);
    return result.rows[0] ? refundFromRow(result.rows[0]) : null;
  }

  private async findPayouts(ids: string[]): Promise<PayoutBatchRecord[]> {
    if (!ids.length) return [];
    const result = await this.pool.query<PayoutBatchRow>(`
      select payout.id::text, payout.venue_id::text, venue.title as venue_title,
        payout.status, payout.amount, payout.scheduled_for, payout.sent_at, payout.paid_at,
        payout.provider_payout_id, payout.account_last_four,
        payout.created_by::text, payout.created_at
      from payout_batches payout
      join venues venue on venue.id = payout.venue_id
      where payout.id = any($1::uuid[])
      order by payout.created_at desc
    `, [ids]);
    return this.hydratePayouts(result.rows);
  }

  private async hydratePayouts(rows: PayoutBatchRow[]): Promise<PayoutBatchRecord[]> {
    if (!rows.length) return [];
    const result = await this.pool.query<PayoutItemRow>(`
      select item.payout_id::text, item.booking_id::text, booking.public_number,
        booking.starts_at, booking.prepayment, booking.commission, item.amount
      from payout_items item
      join bookings booking on booking.id = item.booking_id
      where item.payout_id = any($1::uuid[])
      order by booking.starts_at, booking.id
    `, [rows.map((row) => row.id)]);
    const items = new Map<string, PayoutItemRecord[]>();
    for (const row of result.rows) {
      items.set(row.payout_id, [...(items.get(row.payout_id) ?? []), {
        bookingId: row.booking_id,
        publicNumber: row.public_number,
        startsAt: iso(row.starts_at)!,
        prepayment: amount(row.prepayment),
        commission: amount(row.commission),
        amount: amount(row.amount),
      }]);
    }
    return rows.map((row) => ({
      id: row.id,
      venueId: row.venue_id,
      venueTitle: row.venue_title,
      status: row.status,
      amount: amount(row.amount),
      scheduledFor: row.scheduled_for instanceof Date ? row.scheduled_for.toISOString().slice(0, 10) : row.scheduled_for ? String(row.scheduled_for).slice(0, 10) : null,
      sentAt: iso(row.sent_at),
      paidAt: iso(row.paid_at),
      providerPayoutId: row.provider_payout_id,
      accountLastFour: row.account_last_four?.trim() || null,
      createdBy: row.created_by,
      createdAt: iso(row.created_at)!,
      items: items.get(row.id) ?? [],
    }));
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    actorRole: "partner" | FinanceActorRole,
    action: string,
    entityType: string,
    entityId: string,
    beforeData: Record<string, unknown> | null,
    afterData: Record<string, unknown>,
  ): Promise<void> {
    await client.query(`insert into audit_log (
      actor_id, actor_role, action, entity_type, entity_id, before_data, after_data
    ) values ($1::uuid,$2::user_role,$3,$4,$5,$6::jsonb,$7::jsonb)`, [
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      beforeData === null ? null : JSON.stringify(beforeData),
      JSON.stringify(afterData),
    ]);
  }
}
