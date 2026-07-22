import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { hashPassword, MemoryAuthRepository } from "../src/auth.js";
import {
  PaymentGatewayError,
  type GatewayOrder,
  type GatewayOrderInput,
  type GatewayRefundInput,
  type GatewayRefundStatus,
  type GatewayRefundSubmission,
  type PaymentGateway,
  type VerifiedPaymentEvent,
} from "../src/paymentGateway.js";
import { demoRefundSeed, MemoryRefundRepository, processRefundBatch } from "../src/refunds.js";

class RefundGateway implements PaymentGateway {
  readonly provider = "sber" as const;
  submitCount = 0;
  checkCount = 0;

  constructor(private readonly checks: Array<GatewayRefundStatus | Error>) {}

  async registerOrder(_input: GatewayOrderInput): Promise<GatewayOrder> {
    throw new Error("not used");
  }

  async verifyCallback(_payload: unknown): Promise<VerifiedPaymentEvent> {
    throw new Error("not used");
  }

  async submitRefund(input: GatewayRefundInput): Promise<GatewayRefundSubmission> {
    this.submitCount += 1;
    return { providerRefundId: `SBER-${input.refundId}`, providerPayload: { accepted: true } };
  }

  async checkRefund(_input: GatewayRefundInput): Promise<GatewayRefundStatus> {
    const result = this.checks[Math.min(this.checkCount, this.checks.length - 1)];
    this.checkCount += 1;
    if (result instanceof Error) throw result;
    return result!;
  }
}

const pendingStatus: GatewayRefundStatus = {
  confirmed: false,
  refundedAmount: 0,
  providerPayload: { paymentState: "DEPOSITED" },
};

const refundedStatus: GatewayRefundStatus = {
  confirmed: true,
  refundedAmount: 960,
  providerPayload: { paymentState: "REFUNDED", refundedAmount: 96_000 },
};

test("refund worker submits once and completes only after bank verification", async () => {
  let now = new Date("2026-08-20T12:00:00.000Z");
  const seed = demoRefundSeed({ createdAt: now.toISOString() });
  const repository = new MemoryRefundRepository([seed], () => now);
  const gateway = new RefundGateway([pendingStatus, pendingStatus, refundedStatus]);

  const first = await processRefundBatch(repository, gateway, 20, () => now);
  assert.deepEqual(first, { claimed: 1, succeeded: 0, failed: 1 });
  assert.equal(gateway.submitCount, 1);
  assert.equal(repository.inspect(seed.refundId)?.status, "refund_pending");
  assert.ok(repository.inspect(seed.refundId)?.submittedAt);

  now = new Date("2026-08-20T12:02:00.000Z");
  const second = await processRefundBatch(repository, gateway, 20, () => now);
  assert.deepEqual(second, { claimed: 1, succeeded: 1, failed: 0 });
  assert.equal(gateway.submitCount, 1, "a submitted refund must never be sent again");
  assert.equal(repository.inspect(seed.refundId)?.status, "refunded");
});

test("refund worker does not submit when the bank already reports the refund", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const seed = demoRefundSeed({ createdAt: now.toISOString() });
  const repository = new MemoryRefundRepository([seed], () => now);
  const gateway = new RefundGateway([refundedStatus]);

  const result = await processRefundBatch(repository, gateway, 20, () => now);
  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0 });
  assert.equal(gateway.submitCount, 0);
  assert.equal(repository.inspect(seed.refundId)?.status, "refunded");
});

test("a permanent bank error stops automatic retries until an accountant retries it", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const seed = demoRefundSeed({ createdAt: now.toISOString() });
  const repository = new MemoryRefundRepository([seed], () => now);
  const gateway = new RefundGateway([
    new PaymentGatewayError(409, "SBER_ORDER_MISMATCH", "Банк вернул другой платёж.", false),
  ]);

  const result = await processRefundBatch(repository, gateway, 20, () => now);
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1 });
  assert.equal(repository.inspect(seed.refundId)?.status, "failed");
  assert.equal(repository.inspect(seed.refundId)?.nextAttemptAt, null);

  const retry = await repository.retry(seed.refundId, "accountant", "accountant");
  assert.deepEqual(retry, { outcome: "updated", status: "refund_pending" });
  assert.equal(repository.inspect(seed.refundId)?.attempts, 0);
});

test("stale refund leases are recovered without duplicate submission", async () => {
  const now = new Date("2026-08-20T12:20:00.000Z");
  const seed = demoRefundSeed({
    createdAt: "2026-08-20T12:00:00.000Z",
    attempts: 1,
    submittedAt: "2026-08-20T12:01:00.000Z",
    processingStartedAt: "2026-08-20T12:02:00.000Z",
  });
  const repository = new MemoryRefundRepository([seed], () => now);
  const gateway = new RefundGateway([refundedStatus]);

  const result = await processRefundBatch(repository, gateway, 20, () => now);
  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0 });
  assert.equal(gateway.submitCount, 0);
  assert.equal(repository.inspect(seed.refundId)?.attempts, 2);
});

test("a reclaimed refund rejects writes from the stale worker attempt", async () => {
  const now = new Date("2026-08-20T12:20:00.000Z");
  const seed = demoRefundSeed({
    createdAt: "2026-08-20T12:00:00.000Z",
    attempts: 1,
    processingStartedAt: "2026-08-20T12:02:00.000Z",
  });
  const repository = new MemoryRefundRepository([seed], () => now);
  const [reclaimed] = await repository.claimBatch("sber", 1);
  assert.equal(reclaimed?.attempts, 2);
  const staleWrite = await repository.markSucceeded(
    seed.refundId,
    1,
    { providerRefundId: `SBER-${seed.refundId}`, providerPayload: {} },
    refundedStatus,
  );
  assert.equal(staleWrite, false);
  assert.equal(repository.inspect(seed.refundId)?.status, "refund_pending");
  const currentWrite = await repository.markSucceeded(
    seed.refundId,
    2,
    { providerRefundId: `SBER-${seed.refundId}`, providerPayload: {} },
    refundedStatus,
  );
  assert.equal(currentWrite, true);
});

test("only accounting roles can retry a failed refund", async () => {
  const password = "rooms-refund-test-2026";
  const passwordHash = await hashPassword(password);
  const clientId = "94000000-0000-4000-8000-000000000001";
  const accountantId = "94000000-0000-4000-8000-000000000002";
  const authRepository = new MemoryAuthRepository([
    { id: clientId, role: "client", name: "Refund Client", email: "refund.client@rooms.test", phone: "+79000000401", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
    { id: accountantId, role: "accountant", name: "Refund Accountant", email: "refund.accountant@rooms.test", phone: "+79000000402", city: "Voronezh", passwordHash, passwordResetRequired: false, blockedAt: null },
  ]);
  const failed = demoRefundSeed({ status: "failed", attempts: 5 });
  const pending = demoRefundSeed();
  const refundRepository = new MemoryRefundRepository([failed, pending]);
  const app = buildApp({ logger: false, authRepository, refundRepository });
  await app.ready();
  const login = async (email: string) => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: email, password } });
    return { authorization: `Bearer ${response.json().accessToken as string}` };
  };

  const forbidden = await app.inject({
    method: "POST",
    url: `/v1/accounting/refunds/${failed.refundId}/retry`,
    headers: await login("refund.client@rooms.test"),
  });
  assert.equal(forbidden.statusCode, 403);

  const accountantHeaders = await login("refund.accountant@rooms.test");
  const retried = await app.inject({
    method: "POST",
    url: `/v1/accounting/refunds/${failed.refundId}/retry`,
    headers: accountantHeaders,
  });
  assert.equal(retried.statusCode, 202);
  assert.equal(retried.json().status, "refund_pending");

  const conflict = await app.inject({
    method: "POST",
    url: `/v1/accounting/refunds/${pending.refundId}/retry`,
    headers: accountantHeaders,
  });
  assert.equal(conflict.statusCode, 409);
  await app.close();
});
