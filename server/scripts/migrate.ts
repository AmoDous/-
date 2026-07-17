import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { postgresPoolConfig } from "../src/storage.js";

const migrations = [
  { name: "0001_initial", url: new URL("../../docs/database.sql", import.meta.url) },
  { name: "0002_booking_conversations", url: new URL("../../docs/migrations/0002_booking_conversations.sql", import.meta.url) },
  { name: "0003_partner_catalog", url: new URL("../../docs/migrations/0003_partner_catalog.sql", import.meta.url) },
  { name: "0004_auth_security", url: new URL("../../docs/migrations/0004_auth_security.sql", import.meta.url) },
  { name: "0005_notification_worker", url: new URL("../../docs/migrations/0005_notification_worker.sql", import.meta.url) },
  { name: "0006_partner_photos", url: new URL("../../docs/migrations/0006_partner_photos.sql", import.meta.url) },
];
const pool = new Pool({ ...postgresPoolConfig(), max: 1, application_name: "rooms-migrate" });
const client = await pool.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum char(64) not null,
      applied_at timestamptz not null default now()
    )
  `);
  for (const migration of migrations) {
    const schemaPath = fileURLToPath(migration.url);
    const schema = await readFile(schemaPath, "utf8");
    const checksum = createHash("sha256").update(schema).digest("hex");
    const existing = await client.query<{ checksum: string }>("select checksum from schema_migrations where name = $1", [migration.name]);
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration ${migration.name} was already applied with a different checksum.`);
      }
      console.log(`Migration ${migration.name} is already applied.`);
      continue;
    }
    await client.query("begin");
    await client.query(schema);
    await client.query("insert into schema_migrations(name, checksum) values ($1, $2)", [migration.name, checksum]);
    await client.query("commit");
    console.log(`Applied migration ${migration.name}.`);
  }
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
