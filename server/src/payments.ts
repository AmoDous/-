import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { MemoryBookingRepository } from "./bookings.js";
import type { ExternalPaymentProvider, PaymentGateway, VerifiedPaymentEvent } from "./paymentGateway.js";

export type PaymentStatus = "pending" | "paid" | "failed" | "refunded";
export type PaymentProvider = "rooms_demo" | ExternalPaymentProvider;
export type PaymentCallbackOutcome = "paid" | "already_paid" | "refund_pending" | "ignored";

export interface PaymentRecord {
  paymentId: string;
  bookingId: string;
  status: PaymentStatus;
  provider: PaymentProvider;
  providerPaymentId: string;
  amount: number;
  currency: "RUB";
  redirectUrl: string;
  expiresAt: string;
  maskedCard: string | null;
  receiptNumber: string | null;
  receiptUrl: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface PaymentCallbackResult {
  payment: PaymentRecord;
  bookingId: string;
  outcome: PaymentCallbackOutcome;
  duplicate: boolean;
}

export interface PaymentRepository {
  readonly storage: "memory" | "postgresql";
  readonly provider: PaymentProvider;
  createIntent(clientId: string, bookingId: string): Promise<PaymentRecord>;
  completeDemo(clientId: string, paymentId: string): Promise<PaymentRecord>;
  processProviderCallback(provider: ExternalPaymentProvider, payload: unknown): Promise<PaymentCallbackResult>;
}

export class PaymentActionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

interface MemoryPayment extends PaymentRecord {
  clientId: string;
}

function demoRedirect(paymentId: string): string {
  return `rooms-demo://payment/${paymentId}`;
}

function receiptNumber(): string {
  return `RCP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function paymentUnavailable(status: string): never {
  if (status === "expired") {
    throw new PaymentActionError(409, "PAYMENT_HOLD_EXPIRED", "Время на предоплату истекло. Слот снова доступен для бронирования.");
  }
  throw new PaymentActionError(409, "PAYMENT_UNAVAILABLE", "Эта заявка сейчас не готова к предоплате.");
}

export class MemoryPaymentRepository implements PaymentRepository {
  readonly storage = "memory" as const;
  readonly provider = "rooms_demo" as const;
  private readonly payments = new Map<string, MemoryPayment>();

  constructor(private readonly bookings: MemoryBookingRepository) {}

  async createIntent(clientId: string, bookingId: string): Promise<PaymentRecord> {
    const booking = this.bookings.paymentBooking(clientId, bookingId);
    if (!booking) throw new PaymentActionError(404, "BOOKING_NOT_FOUND", "Бронь не найдена в вашем кабинете.");
    const existing = [...this.payments.values()].find((payment) => payment.bookingId === bookingId && payment.clientId === clientId);
    if (booking.status === "paid" && existing?.status === "paid") return structuredClone(existing);
    if (booking.status !== "awaiting_payment" || !booking.paymentHoldExpiresAt) paymentUnavailable(booking.status);
    if (existing?.status === "pending") return structuredClone(existing);
    const paymentId = randomUUID();
    const payment: MemoryPayment = {
      paymentId,
      bookingId,
      clientId,
      status: "pending",
      provider: "rooms_demo",
      providerPaymentId: `ROOMS-DEMO-${randomUUID()}`,
      amount: booking.money.prepayment,
      currency: "RUB",
      redirectUrl: demoRedirect(paymentId),
      expiresAt: booking.paymentHoldExpiresAt,
      maskedCard: null,
      receiptNumber: null,
      receiptUrl: null,
      createdAt: new Date().toISOString(),
      paidAt: null,
    };
    this.payments.set(payment.paymentId, payment);
    return structuredClone(payment);
  }

  async completeDemo(clientId: string, paymentId: string): Promise<PaymentRecord> {
    const payment = this.payments.get(paymentId);
    if (!payment || payment.clientId !== clientId) throw new PaymentActionError(404, "PAYMENT_NOT_FOUND", "Платёж не найден в вашем кабинете.");
    const booking = this.bookings.paymentBooking(clientId, payment.bookingId);
    if (!booking) throw new PaymentActionError(404, "BOOKING_NOT_FOUND", "Бронь не найдена в вашем кабинете.");
    if (payment.status === "paid" && booking.status === "paid") return structuredClone(payment);
    if (booking.status !== "awaiting_payment" || !booking.paymentHoldExpiresAt) paymentUnavailable(booking.status);
    const completed = this.bookings.completePayment(clientId, booking.id);
    if (!completed || completed.status !== "paid") paymentUnavailable(completed?.status ?? booking.status);
    payment.status = "paid";
    payment.maskedCard = "•••• 4242";
    payment.receiptNumber = receiptNumber();
    payment.paidAt = new Date().toISOString();
    return structuredClone(payment);
  }

  async processProviderCallback(): Promise<PaymentCallbackResult> {
    throw new PaymentActionError(404, "PAYMENT_WEBHOOK_DISABLED", "Внешний платёжный шлюз не подключён.");
  }
}

interface PaymentRow extends QueryResultRow {
  id: string;
  booking_id: string;
  status: PaymentStatus;
  provider: PaymentProvider;
  provider_payment_id: string;
  amount: string | number;
  currency: string;
  masked_card: string | null;
  receipt_number: string | null;
  receipt_url: string | null;
  provider_payload: Record<string, unknown> | null;
  created_at: Date | string;
  paid_at: Date | string | null;
}

interface PaymentBookingRow extends QueryResultRow {
  id: string;
  public_number: string;
  status: string;
  prepayment: string | number;
  payment_hold_expires_at: Date | string | null;
}

interface CallbackPaymentRow extends PaymentRow {
  booking_status: string;
  payment_hold_expires_at: Date | string | null;
}

interface PaymentWebhookEventRow extends QueryResultRow {
  outcome: PaymentCallbackOutcome;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function number(value: string | number): number {
  return Number(Number(value).toFixed(2));
}

function fromRow(row: PaymentRow, expiresAt: Date | string): PaymentRecord {
  const payload = row.provider_payload && typeof row.provider_payload === "object" ? row.provider_payload : {};
  return {
    paymentId: row.id,
    bookingId: row.booking_id,
    status: row.status,
    provider: row.provider,
    providerPaymentId: row.provider_payment_id,
    amount: number(row.amount),
    currency: "RUB",
    redirectUrl: row.provider === "rooms_demo" ? demoRedirect(row.id) : String(payload.redirectUrl ?? ""),
    expiresAt: iso(expiresAt),
    maskedCard: row.masked_card,
    receiptNumber: row.receipt_number,
    receiptUrl: row.receipt_url,
    createdAt: iso(row.created_at),
    paidAt: row.paid_at === null ? null : iso(row.paid_at),
  };
}

export class PostgresPaymentRepository implements PaymentRepository {
  readonly storage = "postgresql" as const;
  readonly provider: PaymentProvider;

  constructor(
    private readonly pool: Pool,
    private readonly gateway: PaymentGateway | null = null,
    private readonly publicSiteUrl = "https://amodous.github.io/Rooms-bron/",
  ) {
    this.provider = gateway?.provider ?? "rooms_demo";
  }

  async createIntent(clientId: string, bookingId: string): Promise<PaymentRecord> {
    if (this.gateway) return this.createExternalIntent(clientId, bookingId);
    return this.createDemoIntent(clientId, bookingId);
  }

  private async createDemoIntent(clientId: string, bookingId: string): Promise<PaymentRecord> {
    await this.releaseExpired();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const bookingResult = await client.query<PaymentBookingRow>(`
        select id::text, status, prepayment, payment_hold_expires_at
        from bookings
        where id = $1::uuid and client_id = $2::uuid
        for update
      `, [bookingId, clientId]);
      const booking = bookingResult.rows[0];
      if (!booking) throw new PaymentActionError(404, "BOOKING_NOT_FOUND", "Бронь не найдена в вашем кабинете.");
      const existingResult = await client.query<PaymentRow>(`
        select id::text, booking_id::text, status, provider, provider_payment_id, amount, currency,
          masked_card, receipt_number, receipt_url, provider_payload, created_at, paid_at
        from payment_transactions
        where booking_id = $1::uuid and status in ('pending','paid')
        order by created_at desc
        limit 1
      `, [bookingId]);
      const existing = existingResult.rows[0];
      if (booking.status === "paid" && existing?.status === "paid") {
        await client.query("commit");
        return fromRow(existing, existing.paid_at ?? existing.created_at);
      }
      if (booking.status !== "awaiting_payment" || !booking.payment_hold_expires_at) paymentUnavailable(booking.status);
      if (new Date(booking.payment_hold_expires_at).getTime() <= Date.now()) paymentUnavailable("expired");
      if (existing?.status === "pending") {
        if (existing.provider !== "rooms_demo") {
          throw new PaymentActionError(409, "PAYMENT_PROVIDER_CHANGED", "Для заявки уже создан платёж через другой шлюз.");
        }
        await client.query("commit");
        return fromRow(existing, booking.payment_hold_expires_at);
      }
      const paymentId = randomUUID();
      const inserted = await client.query<PaymentRow>(`
        insert into payment_transactions (
          id, booking_id, provider, provider_payment_id, idempotency_key, status, amount, currency, provider_payload
        ) values (
          $1::uuid,$2::uuid,'rooms_demo',$3,$4,'pending',$5,'RUB',jsonb_build_object('flow','local_demo','expiresAt',$6::text)
        )
        returning id::text, booking_id::text, status, provider, provider_payment_id, amount, currency,
          masked_card, receipt_number, receipt_url, provider_payload, created_at, paid_at
      `, [paymentId, bookingId, `ROOMS-DEMO-${randomUUID()}`, `booking:${bookingId}:prepayment:v1`, booking.prepayment, iso(booking.payment_hold_expires_at)]);
      await client.query("commit");
      return fromRow(inserted.rows[0]!, booking.payment_hold_expires_at);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async createExternalIntent(clientId: string, bookingId: string): Promise<PaymentRecord> {
    const gateway = this.gateway;
    if (!gateway) throw new PaymentActionError(503, "PAYMENTS_NOT_CONFIGURED", "Онлайн-оплата временно недоступна.");
    await this.releaseExpired();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const bookingResult = await client.query<PaymentBookingRow>(`
        select id::text, public_number, status, prepayment, payment_hold_expires_at
        from bookings
        where id = $1::uuid and client_id = $2::uuid
        for update
      `, [bookingId, clientId]);
      const booking = bookingResult.rows[0];
      if (!booking) throw new PaymentActionError(404, "BOOKING_NOT_FOUND", "Бронь не найдена в вашем кабинете.");
      const existingResult = await client.query<PaymentRow>(`
        select id::text, booking_id::text, status, provider, provider_payment_id, amount, currency,
          masked_card, receipt_number, receipt_url, provider_payload, created_at, paid_at
        from payment_transactions
        where booking_id = $1::uuid and status in ('pending','paid')
        order by created_at desc
        limit 1
      `, [bookingId]);
      const existing = existingResult.rows[0];
      if (booking.status === "paid" && existing?.status === "paid") {
        await client.query("commit");
        return fromRow(existing, existing.paid_at ?? existing.created_at);
      }
      if (booking.status !== "awaiting_payment" || !booking.payment_hold_expires_at) paymentUnavailable(booking.status);
      if (new Date(booking.payment_hold_expires_at).getTime() <= Date.now()) paymentUnavailable("expired");
      if (existing?.status === "pending") {
        if (existing.provider !== gateway.provider) {
          throw new PaymentActionError(409, "PAYMENT_PROVIDER_CHANGED", "Для заявки уже создан платёж через другой шлюз.");
        }
        if (!fromRow(existing, booking.payment_hold_expires_at).redirectUrl) {
          throw new PaymentActionError(409, "PAYMENT_REGISTRATION_INCOMPLETE", "Платёж создаётся. Повторите попытку через несколько секунд.");
        }
        await client.query("commit");
        return fromRow(existing, booking.payment_hold_expires_at);
      }
      const paymentId = randomUUID();
      const returnUrl = this.redirectUrl("success", bookingId);
      const failUrl = this.redirectUrl("failed", bookingId);
      const order = await gateway.registerOrder({
        paymentId,
        bookingId,
        publicNumber: booking.public_number,
        amount: number(booking.prepayment),
        currency: "RUB",
        description: `Предоплата по бронированию ${booking.public_number}`,
        returnUrl,
        failUrl,
      });
      const providerPayload = {
        ...order.providerPayload,
        flow: "hosted_payment_page",
        redirectUrl: order.redirectUrl,
        returnUrl,
        failUrl,
        expiresAt: iso(booking.payment_hold_expires_at),
      };
      const inserted = await client.query<PaymentRow>(`
        insert into payment_transactions (
          id, booking_id, provider, provider_payment_id, idempotency_key, status,
          amount, currency, provider_payload
        ) values ($1::uuid,$2::uuid,$3,$4,$5,'pending',$6,'RUB',$7::jsonb)
        returning id::text, booking_id::text, status, provider, provider_payment_id, amount, currency,
          masked_card, receipt_number, receipt_url, provider_payload, created_at, paid_at
      `, [
        paymentId,
        bookingId,
        gateway.provider,
        order.providerPaymentId,
        `booking:${bookingId}:prepayment:${gateway.provider}:v1`,
        booking.prepayment,
        JSON.stringify(providerPayload),
      ]);
      await client.query("commit");
      return fromRow(inserted.rows[0]!, booking.payment_hold_expires_at);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeDemo(clientId: string, paymentId: string): Promise<PaymentRecord> {
    await this.releaseExpired();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<PaymentRow & PaymentBookingRow>(`
        select payment.id::text, payment.booking_id::text, payment.status, payment.provider,
          payment.provider_payment_id, payment.amount, payment.currency, payment.masked_card,
          payment.receipt_number, payment.receipt_url, payment.provider_payload, payment.created_at, payment.paid_at,
          booking.status as booking_status, booking.payment_hold_expires_at
        from payment_transactions payment
        join bookings booking on booking.id = payment.booking_id
        where payment.id = $1::uuid and booking.client_id = $2::uuid and payment.provider = 'rooms_demo'
        for update of payment, booking
      `, [paymentId, clientId]);
      const row = result.rows[0] as (PaymentRow & { booking_status: string; payment_hold_expires_at: Date | string | null }) | undefined;
      if (!row) throw new PaymentActionError(404, "PAYMENT_NOT_FOUND", "Платёж не найден в вашем кабинете.");
      if (row.status === "paid" && row.booking_status === "paid") {
        await client.query("commit");
        return fromRow(row, row.paid_at ?? row.created_at);
      }
      if (row.booking_status !== "awaiting_payment" || !row.payment_hold_expires_at) paymentUnavailable(row.booking_status);
      if (new Date(row.payment_hold_expires_at).getTime() <= Date.now()) paymentUnavailable("expired");
      const receipt = receiptNumber();
      const paid = await client.query<PaymentRow>(`
        update payment_transactions
        set status = 'paid', masked_card = '•••• 4242', receipt_number = $2,
          provider_payload = provider_payload || jsonb_build_object('completedBy','local_demo'),
          paid_at = now(), updated_at = now()
        where id = $1::uuid
        returning id::text, booking_id::text, status, provider, provider_payment_id, amount, currency,
          masked_card, receipt_number, receipt_url, provider_payload, created_at, paid_at
      `, [paymentId, receipt]);
      await client.query(`
        update bookings
        set status = 'paid', payment_hold_expires_at = null, updated_at = now()
        where id = $1::uuid
      `, [row.booking_id]);
      await client.query(`
        update room_reservations
        set source_type = case when source_type = 'payment_hold' then 'booking'::reservation_source else source_type end,
          expires_at = null,
          details = details || jsonb_build_object('paymentId',$2::text,'paidAt',now()),
          active = true
        where booking_id = $1::uuid and active
      `, [row.booking_id, paymentId]);
      await client.query(`
        insert into booking_status_history (booking_id, from_status, to_status, actor_id, actor_role, title, details)
        values ($1::uuid,'awaiting_payment','paid',$2::uuid,'client','Предоплата внесена',$3)
      `, [row.booking_id, clientId, `Транзакция ${paymentId}`]);
      await client.query(`
        insert into fiscal_receipts (
          payment_id, booking_id, receipt_type, status, amount, currency,
          provider, provider_receipt_id, fiscal_document_number, items, completed_at
        ) values (
          $1::uuid,$2::uuid,'sale','succeeded',$3,'RUB',
          'rooms_demo',$4,$4,
          jsonb_build_array(jsonb_build_object(
            'name','Предоплата по бронированию',
            'quantity',1,
            'price',$3::numeric,
            'amount',$3::numeric,
            'paymentObject','service',
            'paymentMethod','prepayment',
            'tax','none'
          )),now()
        )
        on conflict (payment_id, receipt_type) do nothing
      `, [paymentId, row.booking_id, row.amount, receipt]);
      await client.query("commit");
      return fromRow(paid.rows[0]!, paid.rows[0]!.paid_at ?? paid.rows[0]!.created_at);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async processProviderCallback(provider: ExternalPaymentProvider, payload: unknown): Promise<PaymentCallbackResult> {
    const gateway = this.gateway;
    if (!gateway || gateway.provider !== provider) {
      throw new PaymentActionError(404, "PAYMENT_WEBHOOK_DISABLED", "Этот платёжный шлюз не подключён.");
    }
    const event = await gateway.verifyCallback(payload);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const paymentResult = await client.query<CallbackPaymentRow>(`
        select payment.id::text, payment.booking_id::text, payment.status, payment.provider,
          payment.provider_payment_id, payment.amount, payment.currency, payment.masked_card,
          payment.receipt_number, payment.receipt_url, payment.provider_payload,
          payment.created_at, payment.paid_at,
          booking.status as booking_status, booking.payment_hold_expires_at
        from payment_transactions payment
        join bookings booking on booking.id = payment.booking_id
        where payment.provider = $1 and payment.provider_payment_id = $2
        for update of payment, booking
      `, [provider, event.providerPaymentId]);
      const row = paymentResult.rows[0];
      if (!row) throw new PaymentActionError(404, "PAYMENT_NOT_FOUND", "Платёж из уведомления не найден.");
      if (event.orderNumber !== row.id) {
        throw new PaymentActionError(409, "PAYMENT_ORDER_MISMATCH", "Номер заказа не совпадает с платёжной операцией Rooms.");
      }
      const duplicateResult = await client.query<PaymentWebhookEventRow>(`
        select outcome from payment_webhook_events
        where provider = $1 and event_key = $2
      `, [provider, event.providerEventKey]);
      const duplicate = duplicateResult.rows[0];
      if (duplicate) {
        await client.query("commit");
        return {
          payment: fromRow(row, row.payment_hold_expires_at ?? row.paid_at ?? row.created_at),
          bookingId: row.booking_id,
          outcome: duplicate.outcome,
          duplicate: true,
        };
      }
      let outcome: PaymentCallbackOutcome = "ignored";
      let finalRow: PaymentRow = row;
      if (event.successful) {
        if (number(row.amount) !== event.depositedAmount) {
          throw new PaymentActionError(409, "PAYMENT_AMOUNT_MISMATCH", "Сумма подтверждённого платежа не совпадает с предоплатой Rooms.");
        }
        if (row.status === "refunded") {
          outcome = "ignored";
        } else if (row.status === "paid") {
          const refund = await client.query<{ status: "refund_pending" | "refunded" }>(`
            select status::text from refunds
            where payment_id = $1::uuid and status in ('refund_pending','refunded')
            order by created_at desc
            limit 1
          `, [row.id]);
          outcome = refund.rows[0]?.status === "refund_pending"
            ? "refund_pending"
            : refund.rows[0]?.status === "refunded"
              ? "ignored"
              : row.booking_status === "paid"
                ? "already_paid"
                : "refund_pending";
        } else {
          const paid = await client.query<PaymentRow>(`
            update payment_transactions
            set status = 'paid', masked_card = coalesce($2, masked_card),
              provider_payload = provider_payload || $3::jsonb,
              paid_at = coalesce(paid_at, now()), updated_at = now()
            where id = $1::uuid
            returning id::text, booking_id::text, status, provider, provider_payment_id,
              amount, currency, masked_card, receipt_number, receipt_url,
              provider_payload, created_at, paid_at
          `, [row.id, event.maskedCard, JSON.stringify({ verifiedStatus: event.providerPayload })]);
          finalRow = paid.rows[0]!;
          await this.queueSaleReceipt(client, row.id, row.booking_id, number(row.amount));
          const activeReservation = await client.query<{ exists: boolean }>(`
            select exists(
              select 1 from room_reservations
              where booking_id = $1::uuid and active
                and (expires_at is null or expires_at > now())
            ) as exists
          `, [row.booking_id]);
          const holdIsLive = row.booking_status === "awaiting_payment"
            && row.payment_hold_expires_at !== null
            && new Date(row.payment_hold_expires_at).getTime() > Date.now()
            && Boolean(activeReservation.rows[0]?.exists);
          if (holdIsLive) {
            await client.query(`update bookings
              set status = 'paid', payment_hold_expires_at = null, updated_at = now()
              where id = $1::uuid`, [row.booking_id]);
            await client.query(`update room_reservations
              set source_type = case when source_type = 'payment_hold' then 'booking'::reservation_source else source_type end,
                expires_at = null,
                details = details || jsonb_build_object('paymentId',$2::text,'paidAt',now()),
                active = true
              where booking_id = $1::uuid and active`, [row.booking_id, row.id]);
            await client.query(`insert into booking_status_history (
                booking_id, from_status, to_status, actor_role, title, details
              ) values ($1::uuid,'awaiting_payment','paid','admin','Предоплата подтверждена банком',$2)`, [
              row.booking_id,
              `Транзакция ${row.id}`,
            ]);
            outcome = "paid";
          } else {
            if (row.booking_status === "awaiting_payment") {
              await client.query(`update bookings
                set status = 'expired', payment_hold_expires_at = null, updated_at = now()
                where id = $1::uuid`, [row.booking_id]);
              await client.query(`update room_reservations set active = false
                where booking_id = $1::uuid and active`, [row.booking_id]);
              await client.query(`insert into booking_status_history (
                  booking_id, from_status, to_status, actor_role, title, details
                ) values ($1::uuid,'awaiting_payment','expired','admin','Оплата поступила после освобождения слота','Предоплата направлена в очередь возврата')`, [row.booking_id]);
            }
            await client.query(`insert into refunds (payment_id, amount, status, reason)
              values ($1::uuid,$2,'refund_pending','Оплата поступила после освобождения слота')
              on conflict (payment_id) do nothing`, [row.id, row.amount]);
            outcome = "refund_pending";
          }
        }
      } else if (event.operation === "declinedByTimeout" && row.status === "pending") {
        const failed = await client.query<PaymentRow>(`
          update payment_transactions
          set status = 'failed', provider_payload = provider_payload || $2::jsonb, updated_at = now()
          where id = $1::uuid
          returning id::text, booking_id::text, status, provider, provider_payment_id,
            amount, currency, masked_card, receipt_number, receipt_url,
            provider_payload, created_at, paid_at
        `, [row.id, JSON.stringify({ verifiedStatus: event.providerPayload })]);
        finalRow = failed.rows[0]!;
        if (row.booking_status === "awaiting_payment") {
          await client.query(`update bookings set status = 'expired', payment_hold_expires_at = null, updated_at = now()
            where id = $1::uuid`, [row.booking_id]);
          await client.query(`update room_reservations set active = false
            where booking_id = $1::uuid and active`, [row.booking_id]);
          await client.query(`insert into booking_status_history (
              booking_id, from_status, to_status, actor_role, title, details
            ) values ($1::uuid,'awaiting_payment','expired','admin','Банк закрыл неоплаченный заказ','Слот снова доступен')`, [row.booking_id]);
        }
      }
      await client.query(`insert into payment_webhook_events (
          provider, event_key, provider_payment_id, operation, payload,
          status, outcome, payment_id, processed_at
        ) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::uuid,now())`, [
        provider,
        event.providerEventKey,
        event.providerPaymentId,
        event.operation,
        JSON.stringify(event.providerPayload),
        event.successful ? "processed" : "ignored",
        outcome,
        row.id,
      ]);
      await client.query("commit");
      return {
        payment: fromRow(finalRow, row.payment_hold_expires_at ?? finalRow.paid_at ?? finalRow.created_at),
        bookingId: row.booking_id,
        outcome,
        duplicate: false,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async queueSaleReceipt(client: PoolClient, paymentId: string, bookingId: string, amount: number): Promise<void> {
    await client.query(`insert into fiscal_receipts (
        payment_id, booking_id, receipt_type, status, amount, currency, items
      ) values (
        $1::uuid,$2::uuid,'sale','queued',$3,'RUB',
        jsonb_build_array(jsonb_build_object(
          'name','Предоплата по бронированию',
          'quantity',1,
          'price',$3::numeric,
          'amount',$3::numeric,
          'paymentObject','service',
          'paymentMethod','prepayment',
          'tax','none'
        ))
      ) on conflict (payment_id, receipt_type) do nothing`, [paymentId, bookingId, amount]);
  }

  private redirectUrl(result: "success" | "failed", bookingId: string): string {
    const url = new URL(this.publicSiteUrl);
    url.searchParams.set("payment", result);
    url.searchParams.set("booking", bookingId);
    return url.toString();
  }

  private async releaseExpired(): Promise<void> {
    await this.pool.query(`/* rooms:expire-payment-holds-before-payment */
      with expired as (
        update bookings
        set status = 'expired', payment_hold_expires_at = null, updated_at = now()
        where status = 'awaiting_payment'
          and payment_hold_expires_at is not null
          and payment_hold_expires_at <= now()
        returning id
      ), released as (
        update room_reservations reservation set active = false
        from expired
        where reservation.booking_id = expired.id and reservation.active
        returning reservation.id
      )
      insert into booking_status_history (booking_id, from_status, to_status, actor_role, title, details)
      select id, 'awaiting_payment', 'expired', 'admin', 'Время предоплаты истекло',
        'Слот автоматически освобождён через 15 минут'
      from expired
    `);
  }
}
