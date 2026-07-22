import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import sharp from "sharp";
import { postgresPoolConfig } from "../src/storage.js";

const apiBaseUrl = String(process.env.API_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/u, "");
const pool = new Pool({ ...postgresPoolConfig(), max: 1, application_name: "rooms-partner-catalog-smoke" });
const userId = randomUUID();
const venueId = randomUUID();
const suffix = userId.slice(0, 8);
const email = `smoke.partner.${suffix}@rooms.test`;
const password = "rooms2026";
const adminEmail = "admin@rooms.ru";
const adminPassword = process.env.DEMO_ADMIN_PASSWORD?.trim() || "rooms2026";
let smokeRoomId = "";
const smokePhotoStorageKeys: string[] = [];

async function api<T>(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

async function apiPhoto<T>(path: string, token: string, file: Buffer): Promise<T> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file)], { type: "image/png" }), "smoke-room.png");
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    body: form,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

try {
  const demo = await pool.query<{ password_hash: string | null }>("select password_hash from users where email = 'manager@kids-loft.ru' limit 1");
  const passwordHash = demo.rows[0]?.password_hash;
  if (!passwordHash) throw new Error("Seeded partner account is required for the smoke test.");
  await pool.query(`
    insert into users (id, role, name, email, city, password_hash, password_reset_required)
    values ($1::uuid,'partner','Smoke Partner',$2,'Воронеж',$3,false)
  `, [userId, email, passwordHash]);
  await pool.query(`
    insert into venues (
      id, slug, title, city, address, venue_type, description, rules, contact_name, contact_phone,
      contact_email, amenities, payment_methods, publication_status, verification_status, cabinet_status, partner_mode
    ) values (
      $1::uuid,$2,'Smoke Venue','Воронеж','Тестовый адрес, 1','Лофт','Временная площадка для проверки API.',
      'Тестовые правила.','Smoke Manager','+7 900 000-00-00',$3,array['парковка']::text[],
      array['card','cash']::text[],'published','verified','active','catalog'
    )
  `, [venueId, `smoke-venue-${suffix}`, email]);
  await pool.query("insert into venue_members (venue_id, user_id, member_role) values ($1::uuid,$2::uuid,'manager')", [venueId, userId]);

  const login = await api<{ accessToken: string }>("/v1/auth/login", { method: "POST", body: { login: email, password } });
  assert.ok(login.accessToken);
  const token = login.accessToken;
  const weekSchedule = Array.from({ length: 7 }, (_, index) => ({
    weekday: index + 1,
    enabled: index !== 0,
    opensAtHour: 10,
    closesAtHour: index >= 4 ? 26 : 24,
  }));
  const venue = await api<Record<string, any>>("/v1/partner/venue", { token });
  assert.equal(venue.id, venueId);
  const updatedVenue = await api<Record<string, any>>("/v1/partner/venue", {
    method: "PATCH",
    token,
    body: {
      title: "Smoke Venue Pending",
      city: venue.city,
      address: venue.address,
      venueType: venue.venueType,
      description: venue.description,
      rules: venue.rules,
      contactName: "Updated Smoke Manager",
      contactPhone: "+7 900 111-22-33",
      contactEmail: email,
      amenities: venue.amenities,
      paymentMethods: venue.paymentMethods,
      weekSchedule,
    },
  });
  assert.equal(updatedVenue.title, "Smoke Venue");
  assert.equal(updatedVenue.contactName, "Updated Smoke Manager");
  assert.equal(updatedVenue.pendingChange.proposedData.title, "Smoke Venue Pending");

  const roomWrite = {
    title: "Smoke Room",
    subtitle: "Тестовое помещение",
    type: "lounge",
    description: "Временное помещение для сквозной проверки партнёрского API.",
    rules: "После проверки запись будет полностью удалена.",
    promotion: "",
    capacityMin: 1,
    capacityMax: 10,
    pricePerHour: 1800,
    minimumHours: 2,
    bufferMinutes: 15,
    opensAtHour: 10,
    closesAtHour: 24,
    features: ["parking"],
    tags: ["smoke"],
    services: [{ name: "Проектор", description: "Тестовая услуга", price: 1000 }],
    status: "review",
  };
  const room = await api<Record<string, any>>("/v1/partner/rooms", { method: "POST", token, body: roomWrite });
  smokeRoomId = room.id;
  assert.equal(room.publicationStatus, "review");
  assert.equal(room.services.length, 1);
  const photoSource = await sharp({
    create: { width: 900, height: 1400, channels: 3, background: { r: 194, g: 92, b: 71 } },
  }).png().toBuffer();
  const photo = await apiPhoto<Record<string, any>>(`/v1/partner/rooms/${room.id}/photos`, token, photoSource);
  assert.equal(photo.status, "review");
  smokePhotoStorageKeys.push(String(photo.originalUrl).split("/")[2] || "");
  assert.match(smokePhotoStorageKeys[0] ?? "", /^[0-9a-f-]{36}$/u);
  const generatedPhoto = await fetch(`${apiBaseUrl}${photo.landscapeUrl}`);
  assert.equal(generatedPhoto.status, 200);
  assert.match(generatedPhoto.headers.get("content-type") ?? "", /image\/webp/u);
  const secondPhotoSource = await sharp({
    create: { width: 1400, height: 900, channels: 3, background: { r: 78, g: 113, b: 131 } },
  }).png().toBuffer();
  const secondPhoto = await apiPhoto<Record<string, any>>(`/v1/partner/rooms/${room.id}/photos`, token, secondPhotoSource);
  smokePhotoStorageKeys.push(String(secondPhoto.originalUrl).split("/")[2] || "");
  assert.match(smokePhotoStorageKeys[1] ?? "", /^[0-9a-f-]{36}$/u);
  const reordered = await api<{ status: string; photos: Array<{ id: string; isCover: boolean; sortOrder: number }> }>(
    "/v1/partner/photos/order",
    { method: "PATCH", token, body: { photoIds: [secondPhoto.id, photo.id] } },
  );
  assert.equal(reordered.status, "review");
  assert.deepEqual(reordered.photos.map((item) => item.id), [secondPhoto.id, photo.id]);
  assert.equal(reordered.photos[0]?.isCover, true);
  assert.equal(reordered.photos[0]?.sortOrder, 0);
  const editedRoom = await api<Record<string, any>>(`/v1/partner/rooms/${room.id}`, {
    method: "PATCH",
    token,
    body: { ...roomWrite, title: "Smoke Room Edited", minimumHours: 3, services: room.services },
  });
  assert.equal(editedRoom.title, "Smoke Room Edited");
  assert.equal(editedRoom.minimumHours, 3);

  const adminLogin = await api<{ accessToken: string }>("/v1/auth/login", {
    method: "POST",
    body: { login: adminEmail, password: adminPassword },
  });
  const adminToken = adminLogin.accessToken;
  const pendingModeration = await api<any[]>("/v1/admin/moderation?status=pending&limit=200", { token: adminToken });
  const venueModeration = pendingModeration.find((item) => item.targetId === venueId);
  const roomModeration = pendingModeration.find((item) => item.targetId === room.id);
  assert.ok(venueModeration);
  assert.ok(roomModeration);
  const approvedVenue = await api<Record<string, any>>(`/v1/admin/moderation/${venueModeration.id}/approve`, {
    method: "POST",
    token: adminToken,
    body: { comment: "Smoke venue approved" },
  });
  assert.equal(approvedVenue.status, "approved");
  const approvedRoom = await api<Record<string, any>>(`/v1/admin/moderation/${roomModeration.id}/approve`, {
    method: "POST",
    token: adminToken,
    body: { comment: "Smoke room approved" },
  });
  assert.equal(approvedRoom.status, "approved");
  const approvedVenueView = await api<Record<string, any>>("/v1/partner/venue", { token });
  assert.equal(approvedVenueView.title, "Smoke Venue Pending");
  assert.equal(approvedVenueView.pendingChange, null);
  const approvedRooms = await api<any[]>("/v1/partner/rooms", { token });
  assert.equal(approvedRooms[0]?.title, "Smoke Room Edited");
  assert.equal(approvedRooms[0]?.publicationStatus, "published");
  assert.equal(approvedRooms[0]?.photos[0]?.status, "published");
  assert.equal(approvedRooms[0]?.photos[0]?.id, secondPhoto.id);
  assert.equal(approvedRooms[0]?.photos[0]?.isCover, true);

  const rejectedDraft = await api<Record<string, any>>(`/v1/partner/rooms/${room.id}`, {
    method: "PATCH",
    token,
    body: { ...roomWrite, title: "Smoke Room Must Be Rejected", minimumHours: 3, services: approvedRooms[0].services, status: "published" },
  });
  assert.equal(rejectedDraft.title, "Smoke Room Edited");
  assert.equal(rejectedDraft.pendingChange.proposedData.title, "Smoke Room Must Be Rejected");
  const nextModeration = await api<any[]>("/v1/admin/moderation?status=pending&limit=200", { token: adminToken });
  const rejectedModeration = nextModeration.find((item) => item.targetId === room.id);
  assert.ok(rejectedModeration);
  const rejected = await api<Record<string, any>>(`/v1/admin/moderation/${rejectedModeration.id}/reject`, {
    method: "POST",
    token: adminToken,
    body: { comment: "Smoke rejection reason" },
  });
  assert.equal(rejected.status, "rejected");
  const roomAfterRejection = (await api<any[]>("/v1/partner/rooms", { token }))[0];
  assert.equal(roomAfterRejection.title, "Smoke Room Edited");
  assert.equal(roomAfterRejection.publicationStatus, "published");
  assert.equal(roomAfterRejection.pendingChange, null);
  const moderationHistory = await api<any[]>("/v1/partner/moderation", { token });
  assert.ok(moderationHistory.some((item) => item.status === "rejected" && item.reviewComment === "Smoke rejection reason"));

  const special = await api<Record<string, any>>("/v1/partner/schedule-exceptions/2099-08-15", {
    method: "PUT",
    token,
    body: { mode: "custom", opensAtHour: 12, closesAtHour: 22, note: "Smoke exception" },
  });
  assert.equal(special.scheduleExceptions[0]?.note, "Smoke exception");
  const reset = await api<Record<string, any>>("/v1/partner/schedule-exceptions/2099-08-15", { method: "DELETE", token });
  assert.equal(reset.scheduleExceptions.length, 0);
  const rooms = await api<any[]>("/v1/partner/rooms", { token });
  assert.equal(rooms.length, 1);
  console.log(`Partner catalog smoke passed for venue ${venueId} and room ${room.id}.`);
} finally {
  await pool.query(`delete from audit_log where actor_id = $1::uuid or entity_id = $2 or entity_id = $3
    or before_data->>'targetId' = $2 or before_data->>'targetId' = $3`, [userId, venueId, smokeRoomId]).catch(() => undefined);
  await pool.query("delete from venues where id = $1::uuid", [venueId]).catch(() => undefined);
  await pool.query("delete from users where id = $1::uuid", [userId]).catch(() => undefined);
  for (const storageKey of smokePhotoStorageKeys) {
    if (storageKey) await rm(resolve(process.env.MEDIA_STORAGE_DIR?.trim() || "server-data/media", storageKey), { recursive: true, force: true });
  }
  const cleanup = await pool.query<{ users: number; venues: number }>(`
    select
      (select count(*)::integer from users where id = $1::uuid) as users,
      (select count(*)::integer from venues where id = $2::uuid) as venues
  `, [userId, venueId]);
  assert.deepEqual(cleanup.rows[0], { users: 0, venues: 0 });
  console.log("Partner catalog smoke cleanup passed.");
  await pool.end();
}
