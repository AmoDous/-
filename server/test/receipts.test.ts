import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { hashPassword, MemoryAuthRepository } from "../src/auth.js";
import {
  DemoFiscalReceiptProvider,
  MemoryFiscalReceiptRepository,
  demoFiscalReceiptSeed,
  fiscalReceiptProviderFromEnv,
  processFiscalReceiptBatch,
  type FiscalReceiptProvider,
} from "../src/receipts.js";

test("receipt worker issues a queued receipt exactly once", async () => {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const seed = demoFiscalReceiptSeed({ createdAt: now.toISOString() });
  const repository = new MemoryFiscalReceiptRepository([seed], () => now);
  const provider = new DemoFiscalReceiptProvider();

  const first = await processFiscalReceiptBatch(repository, provider, 20, () => now);
  const second = await processFiscalReceiptBatch(repository, provider, 20, () => now);
  const stored = repository.inspect(seed.id);

  assert.deepEqual(first, { claimed: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(second, { claimed: 0, succeeded: 0, failed: 0 });
  assert.equal(stored?.status, "succeeded");
  assert.equal(stored?.attempts, 1);
  assert.equal(stored?.provider, "rooms_demo_cashbox");
  assert.equal(stored?.providerReceiptId, `ROOMS-DEMO-RECEIPT-${seed.id}`);
});

test("receipt worker delays retries and redacts provider secrets", async () => {
  let clock = new Date("2026-07-20T10:00:00.000Z");
  const seed = demoFiscalReceiptSeed({ createdAt: clock.toISOString() });
  const repository = new MemoryFiscalReceiptRepository([seed], () => clock);
  let fail = true;
  const provider: FiscalReceiptProvider = {
    providerName: "cashbox_test",
    issue: async (job) => {
      if (fail) throw new Error("provider token=very-secret-token is unavailable");
      return {
        providerReceiptId: `TEST-${job.id}`,
        fiscalDocumentNumber: "42",
        fiscalSign: "84",
        receiptUrl: null,
      };
    },
  };

  const failed = await processFiscalReceiptBatch(repository, provider, 20, () => clock);
  const afterFailure = repository.inspect(seed.id);
  assert.deepEqual(failed, { claimed: 1, succeeded: 0, failed: 1 });
  assert.equal(afterFailure?.status, "failed");
  assert.equal(afterFailure?.nextAttemptAt, "2026-07-20T10:01:00.000Z");
  assert.equal(afterFailure?.lastError?.includes("very-secret-token"), false);
  assert.match(afterFailure?.lastError ?? "", /token=\[redacted\]/u);

  assert.deepEqual(
    await processFiscalReceiptBatch(repository, provider, 20, () => clock),
    { claimed: 0, succeeded: 0, failed: 0 },
  );
  clock = new Date("2026-07-20T10:01:00.000Z");
  fail = false;
  assert.deepEqual(
    await processFiscalReceiptBatch(repository, provider, 20, () => clock),
    { claimed: 1, succeeded: 1, failed: 0 },
  );
  assert.equal(repository.inspect(seed.id)?.attempts, 2);
});

test("receipt queue reclaims a stale job without handing it to two workers", async () => {
  const now = new Date("2026-07-20T10:30:00.000Z");
  const seed = demoFiscalReceiptSeed({
    status: "processing",
    attempts: 1,
    processingStartedAt: "2026-07-20T10:00:00.000Z",
  });
  const repository = new MemoryFiscalReceiptRepository([seed], () => now);

  const [left, right] = await Promise.all([repository.claimBatch(1), repository.claimBatch(1)]);
  assert.equal(left.length + right.length, 1);
  assert.equal(repository.inspect(seed.id)?.status, "processing");
  assert.equal(repository.inspect(seed.id)?.attempts, 2);
});

test("demo fiscal provider is disabled by default and refused in production", () => {
  assert.equal(fiscalReceiptProviderFromEnv({}), null);
  assert.throws(
    () => fiscalReceiptProviderFromEnv({ FISCAL_RECEIPT_MODE: "demo", NODE_ENV: "production" }),
    /cannot run in production/u,
  );
});

test("only accounting roles can retry and cancel fiscal receipts", async () => {
  const clientId = randomUUID();
  const accountantId = randomUUID();
  const password = "rooms-receipts-2026";
  const passwordHash = await hashPassword(password);
  const authRepository = new MemoryAuthRepository([
    {
      id: clientId,
      role: "client",
      name: "Receipt Client",
      email: "receipt.client@rooms.test",
      phone: "+79000000201",
      city: "Voronezh",
      passwordHash,
      passwordResetRequired: false,
      blockedAt: null,
    },
    {
      id: accountantId,
      role: "accountant",
      name: "Receipt Accountant",
      email: "receipt.accountant@rooms.test",
      phone: "+79000000202",
      city: "Voronezh",
      passwordHash,
      passwordResetRequired: false,
      blockedAt: null,
    },
  ]);
  const failed = demoFiscalReceiptSeed({ status: "failed", attempts: 5, nextAttemptAt: null });
  const succeeded = demoFiscalReceiptSeed({ status: "succeeded", attempts: 1 });
  const receiptRepository = new MemoryFiscalReceiptRepository([failed, succeeded]);
  const app = buildApp({ logger: false, authRepository, receiptRepository });
  await app.ready();

  const login = async (email: string) => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: email, password } });
    return { authorization: `Bearer ${response.json().accessToken as string}` };
  };
  const clientHeaders = await login("receipt.client@rooms.test");
  const accountantHeaders = await login("receipt.accountant@rooms.test");

  const forbidden = await app.inject({
    method: "POST",
    url: `/v1/accounting/receipts/${failed.id}/retry`,
    headers: clientHeaders,
  });
  assert.equal(forbidden.statusCode, 403);

  const retried = await app.inject({
    method: "POST",
    url: `/v1/accounting/receipts/${failed.id}/retry`,
    headers: accountantHeaders,
  });
  assert.equal(retried.statusCode, 202);
  assert.equal(retried.json().status, "queued");
  assert.equal(receiptRepository.inspect(failed.id)?.attempts, 0);

  const cancelled = await app.inject({
    method: "POST",
    url: `/v1/accounting/receipts/${failed.id}/cancel`,
    headers: accountantHeaders,
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, "cancelled");

  const conflict = await app.inject({
    method: "POST",
    url: `/v1/accounting/receipts/${succeeded.id}/cancel`,
    headers: accountantHeaders,
  });
  assert.equal(conflict.statusCode, 409);

  const missing = await app.inject({
    method: "POST",
    url: `/v1/accounting/receipts/${randomUUID()}/retry`,
    headers: accountantHeaders,
  });
  assert.equal(missing.statusCode, 404);
  await app.close();
});
