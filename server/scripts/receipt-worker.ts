import "dotenv/config";
import { fiscalReceiptProviderFromEnv, processFiscalReceiptBatch } from "../src/receipts.js";
import { createCatalogStorage } from "../src/storage.js";

const provider = fiscalReceiptProviderFromEnv();
if (!provider) throw new Error("Set FISCAL_RECEIPT_MODE to a configured provider before running the receipt worker.");

const storage = await createCatalogStorage();
try {
  const summary = await processFiscalReceiptBatch(
    storage.receiptRepository,
    provider,
    Number(process.env.FISCAL_RECEIPT_WORKER_BATCH_SIZE || 20),
  );
  console.log(JSON.stringify({ provider: provider.providerName, ...summary }));
} finally {
  await storage.close();
}
