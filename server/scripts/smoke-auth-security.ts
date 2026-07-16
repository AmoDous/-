import "dotenv/config";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { postgresPoolConfig } from "../src/storage.js";

const baseUrl = process.env.SMOKE_API_URL?.trim() || "http://127.0.0.1:3001";
const email = "auth-security-smoke@rooms.test";
const phone = "+79009990041";
const oldPassword = "rooms-smoke-old-2026";
const newPassword = "rooms-smoke-new-2026";
const pool = new Pool({ ...postgresPoolConfig(), max: 1, application_name: "rooms-auth-security-smoke" });

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, payload };
}

await pool.query("delete from users where email = $1", [email]);

try {
  const created = await request("/v1/auth/client/register", {
    method: "POST",
    headers: { "User-Agent": "Rooms Smoke Desktop" },
    body: JSON.stringify({
      name: "Проверка безопасности",
      email,
      phone,
      city: "Воронеж",
      password: oldPassword,
      legal: { termsVersion: "smoke-1", privacyVersion: "smoke-1", acceptedAt: new Date().toISOString() },
    }),
  });
  assert.equal(created.response.status, 201);
  const firstAccess = String((created.payload as { accessToken?: string }).accessToken ?? "");
  assert.ok(firstAccess);

  const second = await request("/v1/auth/login", {
    method: "POST",
    headers: { "User-Agent": "Rooms Smoke Mobile" },
    body: JSON.stringify({ login: email, password: oldPassword }),
  });
  assert.equal(second.response.status, 200);

  const sessions = await request("/v1/me/sessions", { headers: { Authorization: `Bearer ${firstAccess}` } });
  assert.equal(sessions.response.status, 200);
  assert.equal((sessions.payload as { items: unknown[] }).items.length, 2);

  const resetRequest = await request("/v1/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ login: email }),
  });
  assert.equal(resetRequest.response.status, 202);
  const token = String((resetRequest.payload as { demoToken?: string }).demoToken ?? "");
  assert.ok(token, "EXPOSE_PASSWORD_RESET_TOKEN must be enabled for the local smoke test.");

  const reset = await request("/v1/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({ token, newPassword }),
  });
  assert.equal(reset.response.status, 204);

  const oldSession = await request("/v1/me", { headers: { Authorization: `Bearer ${firstAccess}` } });
  assert.equal(oldSession.response.status, 401);
  const oldLogin = await request("/v1/auth/login", { method: "POST", body: JSON.stringify({ login: email, password: oldPassword }) });
  assert.equal(oldLogin.response.status, 401);
  const newLogin = await request("/v1/auth/login", { method: "POST", body: JSON.stringify({ login: email, password: newPassword }) });
  assert.equal(newLogin.response.status, 200);
  const replay = await request("/v1/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, newPassword: "rooms-smoke-replay-2026" }) });
  assert.equal(replay.response.status, 400);

  console.log("Auth security smoke passed against PostgreSQL.");
} finally {
  await pool.query("delete from users where email = $1", [email]);
  await pool.end();
}
