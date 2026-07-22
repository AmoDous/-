import { createHash } from "node:crypto";

export type ExternalPaymentProvider = "sber";
export type SberPaymentOperation = "created" | "approved" | "deposited" | "reversed" | "refunded" | "declinedByTimeout" | "subscriptionCreated";

export interface GatewayOrderInput {
  paymentId: string;
  bookingId: string;
  publicNumber: string;
  amount: number;
  currency: "RUB";
  description: string;
  returnUrl: string;
  failUrl: string;
}

export interface GatewayOrder {
  provider: ExternalPaymentProvider;
  providerPaymentId: string;
  redirectUrl: string;
  providerPayload: Record<string, unknown>;
}

export interface GatewayRefundInput {
  refundId: string;
  paymentId: string;
  providerPaymentId: string;
  amount: number;
  currency: "RUB";
}

export interface GatewayRefundSubmission {
  providerRefundId: string;
  providerPayload: Record<string, unknown>;
}

export interface GatewayRefundStatus {
  confirmed: boolean;
  refundedAmount: number;
  providerPayload: Record<string, unknown>;
}

export interface SberCallbackPayload {
  mdOrder: string;
  orderNumber: string;
  operation: SberPaymentOperation;
  status: 0 | 1;
  additionalParams?: Record<string, unknown>;
}

export interface VerifiedPaymentEvent {
  provider: ExternalPaymentProvider;
  providerPaymentId: string;
  providerEventKey: string;
  orderNumber: string;
  operation: SberPaymentOperation;
  successful: boolean;
  depositedAmount: number;
  currency: "RUB";
  maskedCard: string | null;
  providerPayload: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly provider: ExternalPaymentProvider;
  registerOrder(input: GatewayOrderInput): Promise<GatewayOrder>;
  verifyCallback(payload: unknown): Promise<VerifiedPaymentEvent>;
  submitRefund(input: GatewayRefundInput): Promise<GatewayRefundSubmission>;
  checkRefund(input: GatewayRefundInput): Promise<GatewayRefundStatus>;
}

export class PaymentGatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = statusCode >= 500,
  ) {
    super(message);
  }
}

interface SberGatewayConfig {
  baseUrl: string;
  userName: string;
  password: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface SberRegisterResponse {
  errorCode?: string | number;
  errorMessage?: string;
  orderId?: string;
  formUrl?: string;
  externalParams?: Record<string, unknown>;
}

interface SberRefundResponse {
  errorCode?: string | number;
  errorMessage?: string;
}

interface SberStatusResponse {
  errorCode?: string | number;
  errorMessage?: string;
  orderNumber?: string;
  orderStatus?: number;
  actionCode?: number;
  currency?: string;
  cardAuthInfo?: { maskedPan?: string };
  paymentAmountInfo?: {
    approvedAmount?: number;
    depositedAmount?: number;
    refundedAmount?: number;
    paymentState?: string;
  };
}

const sberOperations = new Set<SberPaymentOperation>([
  "created",
  "approved",
  "deposited",
  "reversed",
  "refunded",
  "declinedByTimeout",
  "subscriptionCreated",
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseCallback(value: unknown): SberCallbackPayload {
  const body = object(value);
  if (!body) throw new PaymentGatewayError(400, "INVALID_SBER_CALLBACK", "Некорректное уведомление платёжного шлюза.");
  const mdOrder = String(body.mdOrder ?? "").trim();
  const orderNumber = String(body.orderNumber ?? "").trim();
  const operation = String(body.operation ?? "") as SberPaymentOperation;
  const status = Number(body.status);
  if (!/^[0-9a-f-]{36}$/iu.test(mdOrder) || orderNumber.length < 1 || orderNumber.length > 36 || !sberOperations.has(operation) || (status !== 0 && status !== 1)) {
    throw new PaymentGatewayError(400, "INVALID_SBER_CALLBACK", "Некорректное уведомление платёжного шлюза.");
  }
  const additionalParams = object(body.additionalParams);
  return {
    mdOrder,
    orderNumber,
    operation,
    status: status as 0 | 1,
    ...(additionalParams ? { additionalParams } : {}),
  };
}

function rublesFromMinor(value: unknown): number {
  const minor = Number(value);
  if (!Number.isInteger(minor) || minor < 0) return 0;
  return Number((minor / 100).toFixed(2));
}

function safeStatusPayload(status: SberStatusResponse): Record<string, unknown> {
  return {
    errorCode: String(status.errorCode ?? ""),
    orderStatus: Number(status.orderStatus),
    actionCode: Number(status.actionCode),
    currency: String(status.currency ?? "643"),
    paymentAmountInfo: {
      approvedAmount: Number(status.paymentAmountInfo?.approvedAmount ?? 0),
      depositedAmount: Number(status.paymentAmountInfo?.depositedAmount ?? 0),
      refundedAmount: Number(status.paymentAmountInfo?.refundedAmount ?? 0),
      paymentState: String(status.paymentAmountInfo?.paymentState ?? ""),
    },
    maskedPan: status.cardAuthInfo?.maskedPan ?? null,
  };
}

export class SberPaymentGateway implements PaymentGateway {
  readonly provider = "sber" as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SberGatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/u, "");
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
      throw new Error("SBER_API_BASE_URL must use HTTPS outside local tests.");
    }
    if (!config.userName.trim() || !config.password) throw new Error("SBER_USERNAME and SBER_PASSWORD are required.");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 30000) {
      throw new Error("SBER_REQUEST_TIMEOUT_MS must be between 1000 and 30000.");
    }
  }

  async registerOrder(input: GatewayOrderInput): Promise<GatewayOrder> {
    const minorAmount = Math.round(input.amount * 100);
    if (!Number.isInteger(minorAmount) || minorAmount <= 0) {
      throw new PaymentGatewayError(400, "INVALID_PAYMENT_AMOUNT", "Сумма предоплаты должна быть больше нуля.");
    }
    const response = await this.post<SberRegisterResponse>("/ecomm/gw/partner/api/v1/register.do", {
      userName: this.config.userName,
      password: this.config.password,
      orderNumber: input.paymentId,
      amount: minorAmount,
      currency: "643",
      returnUrl: input.returnUrl,
      failUrl: input.failUrl,
      description: input.description.slice(0, 512),
      jsonParams: {
        roomsBookingId: input.bookingId,
        roomsPublicNumber: input.publicNumber,
      },
    });
    if (String(response.errorCode ?? "") !== "0" || !response.orderId || !response.formUrl) {
      throw new PaymentGatewayError(502, "SBER_ORDER_REGISTRATION_FAILED", "Банк не смог создать платёж. Попробуйте ещё раз.");
    }
    let hostedPage: URL;
    try {
      hostedPage = new URL(response.formUrl);
    } catch {
      throw new PaymentGatewayError(502, "SBER_INVALID_PAYMENT_URL", "Банк вернул некорректный адрес платёжной страницы.");
    }
    if (hostedPage.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(hostedPage.hostname)) {
      throw new PaymentGatewayError(502, "SBER_INVALID_PAYMENT_URL", "Банк вернул небезопасный адрес платёжной страницы.");
    }
    return {
      provider: "sber",
      providerPaymentId: response.orderId,
      redirectUrl: hostedPage.toString(),
      providerPayload: {
        registrationErrorCode: "0",
        sberPayAvailable: Boolean(response.externalParams?.sbolDeepLink),
      },
    };
  }

  async verifyCallback(value: unknown): Promise<VerifiedPaymentEvent> {
    const callback = parseCallback(value);
    const status = await this.post<SberStatusResponse>("/ecomm/gw/partner/api/v1/getOrderStatusExtended.do", {
      userName: this.config.userName,
      password: this.config.password,
      orderId: callback.mdOrder,
      language: "ru",
    });
    if (String(status.errorCode ?? "") !== "0") {
      throw new PaymentGatewayError(502, "SBER_STATUS_UNAVAILABLE", "Банк не подтвердил состояние платежа.");
    }
    if (status.orderNumber && status.orderNumber !== callback.orderNumber) {
      throw new PaymentGatewayError(409, "SBER_ORDER_MISMATCH", "Идентификатор заказа в уведомлении не совпадает.");
    }
    const deposited = Number(status.orderStatus) === 2
      && String(status.paymentAmountInfo?.paymentState ?? "").toUpperCase() === "DEPOSITED"
      && Number(status.paymentAmountInfo?.depositedAmount ?? 0) > 0;
    if (callback.operation === "deposited" && callback.status === 1 && !deposited) {
      throw new PaymentGatewayError(503, "SBER_PAYMENT_NOT_FINAL", "Банк ещё не подтвердил окончательное списание.");
    }
    const providerEventKey = createHash("sha256")
      .update(`${callback.mdOrder}|${callback.orderNumber}|${callback.operation}|${callback.status}`)
      .digest("hex");
    return {
      provider: "sber",
      providerPaymentId: callback.mdOrder,
      providerEventKey,
      orderNumber: callback.orderNumber,
      operation: callback.operation,
      successful: callback.operation === "deposited" && callback.status === 1 && deposited,
      depositedAmount: rublesFromMinor(status.paymentAmountInfo?.depositedAmount),
      currency: "RUB",
      maskedCard: status.cardAuthInfo?.maskedPan ?? null,
      providerPayload: safeStatusPayload(status),
    };
  }

  async submitRefund(input: GatewayRefundInput): Promise<GatewayRefundSubmission> {
    const minorAmount = this.refundMinorAmount(input);
    const idempotencyKey = this.refundIdempotencyKey(input.refundId);
    const response = await this.post<SberRefundResponse>(
      "/ecomm/gw/partner/api/v1/refund.do",
      {
        userName: this.config.userName,
        password: this.config.password,
        orderId: input.providerPaymentId,
        amount: minorAmount,
      },
      { "x-idempotencyKey": idempotencyKey },
    );
    if (String(response.errorCode ?? "") !== "0") {
      throw new PaymentGatewayError(
        502,
        "SBER_REFUND_REJECTED",
        "Банк пока не принял возврат. Rooms повторит запрос автоматически.",
      );
    }
    return {
      providerRefundId: `SBER-${input.refundId}`,
      providerPayload: {
        refundErrorCode: "0",
        idempotencyKey,
      },
    };
  }

  async checkRefund(input: GatewayRefundInput): Promise<GatewayRefundStatus> {
    const expectedMinorAmount = this.refundMinorAmount(input);
    const status = await this.orderStatus(input.providerPaymentId);
    if (status.orderNumber && status.orderNumber !== input.paymentId) {
      throw new PaymentGatewayError(409, "SBER_ORDER_MISMATCH", "Банк вернул состояние другого платежа.", false);
    }
    const refundedMinorAmount = Number(status.paymentAmountInfo?.refundedAmount ?? 0);
    return {
      confirmed: Number.isInteger(refundedMinorAmount) && refundedMinorAmount >= expectedMinorAmount,
      refundedAmount: rublesFromMinor(refundedMinorAmount),
      providerPayload: safeStatusPayload(status),
    };
  }

  private refundMinorAmount(input: GatewayRefundInput): number {
    const minorAmount = Math.round(input.amount * 100);
    if (input.currency !== "RUB" || !Number.isInteger(minorAmount) || minorAmount <= 0) {
      throw new PaymentGatewayError(400, "INVALID_REFUND_AMOUNT", "Сумма возврата должна быть положительной.", false);
    }
    return minorAmount;
  }

  private refundIdempotencyKey(refundId: string): string {
    const key = `rooms-refund-${refundId}`;
    if (!/^[0-9a-zA-Z-_#]{1,255}$/u.test(key)) {
      throw new PaymentGatewayError(400, "INVALID_REFUND_ID", "Некорректный идентификатор возврата.", false);
    }
    return key;
  }

  private async orderStatus(providerPaymentId: string): Promise<SberStatusResponse> {
    const status = await this.post<SberStatusResponse>("/ecomm/gw/partner/api/v1/getOrderStatusExtended.do", {
      userName: this.config.userName,
      password: this.config.password,
      orderId: providerPaymentId,
      language: "ru",
    });
    if (String(status.errorCode ?? "") !== "0") {
      throw new PaymentGatewayError(502, "SBER_STATUS_UNAVAILABLE", "Банк не подтвердил состояние платежа.");
    }
    return status;
  }

  private async post<T>(path: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new PaymentGatewayError(502, "SBER_HTTP_ERROR", "Платёжный шлюз временно недоступен.");
      const payload = await response.json().catch(() => null);
      if (!object(payload)) throw new PaymentGatewayError(502, "SBER_INVALID_RESPONSE", "Платёжный шлюз вернул некорректный ответ.");
      return payload as T;
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw error;
      if ((error as { name?: string }).name === "AbortError") {
        throw new PaymentGatewayError(504, "SBER_TIMEOUT", "Платёжный шлюз не ответил вовремя.");
      }
      throw new PaymentGatewayError(502, "SBER_UNAVAILABLE", "Не удалось связаться с платёжным шлюзом.");
    } finally {
      clearTimeout(timeout);
    }
  }
}
