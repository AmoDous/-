import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { PaymentGatewayError, SberPaymentGateway } from "../src/paymentGateway.js";
import type { PaymentRecord, PaymentRepository } from "../src/payments.js";

const orderInput = {
  paymentId: "91000000-0000-4000-8000-000000000001",
  bookingId: "91000000-0000-4000-8000-000000000002",
  publicNumber: "ROOMS-TEST-101",
  amount: 960,
  currency: "RUB" as const,
  description: "Rooms test prepayment",
  returnUrl: "https://rooms.example/payment=success",
  failUrl: "https://rooms.example/payment=failed",
};

function gateway(fetchImpl: typeof fetch): SberPaymentGateway {
  return new SberPaymentGateway({
    baseUrl: "https://ecomtest.sberbank.ru",
    userName: "rooms-test-user",
    password: "secret-bank-password",
    fetchImpl,
  });
}

test("Sber hosted order uses minor units and never exposes credentials", async () => {
  let requestBody: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.match(String(input), /\/register\.do$/u);
    assert.equal(init?.method, "POST");
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      errorCode: "0",
      orderId: "92000000-0000-4000-8000-000000000001",
      formUrl: "https://ecomtest.sberbank.ru/pp/pay_ru?order=1",
      externalParams: { sbolDeepLink: "sberpay://payment" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const order = await gateway(fetchImpl).registerOrder(orderInput);
  assert.equal(requestBody.amount, 96_000);
  assert.equal(requestBody.currency, "643");
  assert.equal(requestBody.orderNumber, orderInput.paymentId);
  assert.equal(requestBody.returnUrl, orderInput.returnUrl);
  assert.equal(order.provider, "sber");
  assert.match(order.redirectUrl, /^https:\/\//u);
  assert.equal(JSON.stringify(order).includes("secret-bank-password"), false);
  assert.deepEqual(order.providerPayload, { registrationErrorCode: "0", sberPayAvailable: true });
});

test("Sber hosted order rejects a non-HTTPS payment page", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    errorCode: "0",
    orderId: "92000000-0000-4000-8000-000000000009",
    formUrl: "http://payment.example/collect-card",
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    gateway(fetchImpl).registerOrder(orderInput),
    (error: unknown) => error instanceof PaymentGatewayError && error.code === "SBER_INVALID_PAYMENT_URL",
  );
});

test("Sber refund uses minor units, a stable idempotency key and verifies the refunded amount", async () => {
  const providerPaymentId = "92000000-0000-4000-8000-000000000008";
  const refundId = "93000000-0000-4000-8000-000000000001";
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, body, headers });
    if (url.endsWith("/refund.do")) {
      return new Response(JSON.stringify({ errorCode: "0", errorMessage: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      errorCode: "0",
      orderNumber: orderInput.paymentId,
      orderStatus: 4,
      actionCode: 0,
      currency: "643",
      paymentAmountInfo: { depositedAmount: 96_000, refundedAmount: 96_000, paymentState: "REFUNDED" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const input = {
    refundId,
    paymentId: orderInput.paymentId,
    providerPaymentId,
    amount: 960,
    currency: "RUB" as const,
  };

  const submission = await gateway(fetchImpl).submitRefund(input);
  const status = await gateway(fetchImpl).checkRefund(input);

  assert.equal(calls[0]?.body.amount, 96_000);
  assert.equal(calls[0]?.body.orderId, providerPaymentId);
  assert.equal(calls[0]?.headers["x-idempotencyKey"], `rooms-refund-${refundId}`);
  assert.equal(status.confirmed, true);
  assert.equal(status.refundedAmount, 960);
  assert.equal(JSON.stringify({ submission, status }).includes("secret-bank-password"), false);
});

test("Sber callback is accepted only after a server-to-server deposited status", async () => {
  const providerPaymentId = "92000000-0000-4000-8000-000000000002";
  let statusRequest: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.match(String(input), /\/getOrderStatusExtended\.do$/u);
    statusRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      errorCode: "0",
      orderNumber: orderInput.paymentId,
      orderStatus: 2,
      actionCode: 0,
      currency: "643",
      cardAuthInfo: { maskedPan: "411111******1111" },
      paymentAmountInfo: {
        approvedAmount: 96_000,
        depositedAmount: 96_000,
        refundedAmount: 0,
        paymentState: "DEPOSITED",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const verified = await gateway(fetchImpl).verifyCallback({
    mdOrder: providerPaymentId,
    orderNumber: orderInput.paymentId,
    operation: "deposited",
    status: 1,
    additionalParams: {},
  });
  assert.equal(statusRequest.orderId, providerPaymentId);
  assert.equal(verified.successful, true);
  assert.equal(verified.depositedAmount, 960);
  assert.equal(verified.maskedCard, "411111******1111");
  assert.match(verified.providerEventKey, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(verified).includes("secret-bank-password"), false);
});

test("Sber deposited callback is rejected while the bank status is not final", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    errorCode: "0",
    orderNumber: orderInput.paymentId,
    orderStatus: 1,
    actionCode: 0,
    paymentAmountInfo: { depositedAmount: 0, paymentState: "APPROVED" },
  }), { status: 200, headers: { "content-type": "application/json" } });

  await assert.rejects(
    gateway(fetchImpl).verifyCallback({
      mdOrder: "92000000-0000-4000-8000-000000000003",
      orderNumber: orderInput.paymentId,
      operation: "deposited",
      status: 1,
    }),
    (error: unknown) => error instanceof PaymentGatewayError && error.code === "SBER_PAYMENT_NOT_FINAL",
  );
});

test("invalid callback is rejected before any request to the bank", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    gateway(fetchImpl).verifyCallback({ mdOrder: "not-an-order", operation: "deposited", status: 1 }),
    (error: unknown) => error instanceof PaymentGatewayError && error.code === "INVALID_SBER_CALLBACK",
  );
  assert.equal(called, false);
});

test("public Sber webhook accepts the documented body and delegates verification", async () => {
  let received: unknown = null;
  const payment: PaymentRecord = {
    paymentId: orderInput.paymentId,
    bookingId: orderInput.bookingId,
    status: "paid",
    provider: "sber",
    providerPaymentId: "92000000-0000-4000-8000-000000000004",
    amount: 960,
    currency: "RUB",
    redirectUrl: "https://ecomtest.sberbank.ru/pp/pay_ru?order=4",
    expiresAt: "2026-08-20T12:15:00.000Z",
    maskedCard: "411111******1111",
    receiptNumber: null,
    receiptUrl: null,
    createdAt: "2026-08-20T12:00:00.000Z",
    paidAt: "2026-08-20T12:01:00.000Z",
  };
  const paymentRepository: PaymentRepository = {
    storage: "memory",
    provider: "sber",
    createIntent: async () => payment,
    completeDemo: async () => payment,
    processProviderCallback: async (provider, payload) => {
      assert.equal(provider, "sber");
      received = payload;
      return { payment, bookingId: payment.bookingId, outcome: "paid", duplicate: false };
    },
  };
  const app = buildApp({ logger: false, paymentRepository });
  const payload = {
    mdOrder: payment.providerPaymentId,
    orderNumber: payment.paymentId,
    operation: "deposited",
    status: 1,
    additionalParams: {},
  };
  const response = await app.inject({ method: "POST", url: "/v1/payments/webhooks/sber", payload });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.deepEqual(received, payload);

  const invalid = await app.inject({ method: "POST", url: "/v1/payments/webhooks/sber", payload: { ...payload, unexpected: true } });
  assert.equal(invalid.statusCode, 200);
  assert.equal("unexpected" in (received as Record<string, unknown>), false);
  await app.close();
});
