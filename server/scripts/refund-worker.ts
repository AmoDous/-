import "dotenv/config";
import { processRefundBatch } from "../src/refunds.js";
import { createCatalogStorage } from "../src/storage.js";

const storage = await createCatalogStorage();
try {
  if (!storage.refundProvider) {
    throw new Error("Set PAYMENT_PROVIDER=sber and configure Sber credentials before running the refund worker.");
  }
  const summary = await processRefundBatch(
    storage.refundRepository,
    storage.refundProvider,
    Number(process.env.REFUND_WORKER_BATCH_SIZE || 20),
  );
  console.log(JSON.stringify({ provider: storage.refundProvider.provider, ...summary }));
} finally {
  await storage.close();
}
