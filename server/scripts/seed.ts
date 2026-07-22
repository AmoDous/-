import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import { hashPassword } from "../src/auth.js";
import { demoReviews, demoRooms, demoVenues, venueIds } from "../src/catalog.js";
import { postgresPoolConfig } from "../src/storage.js";

if (process.env.ALLOW_DEMO_SEED !== "true") {
  throw new Error("Set ALLOW_DEMO_SEED=true to confirm loading Rooms demo data.");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("Rooms demo seed is disabled in production.");
}

const demoPartnerPassword = process.env.DEMO_PARTNER_PASSWORD?.trim() || "rooms2026";
const demoAdminPassword = process.env.DEMO_ADMIN_PASSWORD?.trim() || "rooms2026";
const demoAccountantPassword = process.env.DEMO_ACCOUNTANT_PASSWORD?.trim() || "rooms2026";

function hourToTime(value: number): string {
  const normalized = ((value % 24) + 24) % 24;
  const hours = Math.floor(normalized);
  const minutes = Math.round((normalized - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
}

async function seedVenue(client: PoolClient, venue: (typeof demoVenues)[number]): Promise<void> {
  await client.query(`
    insert into venues (
      id, slug, title, city, address, description, rules, amenities, payment_methods,
      publication_status, verification_status, cabinet_status, partner_mode
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published','verified','active',$10)
    on conflict (id) do update set
      slug = excluded.slug, title = excluded.title, city = excluded.city, address = excluded.address,
      description = excluded.description, rules = excluded.rules, amenities = excluded.amenities,
      payment_methods = excluded.payment_methods, updated_at = now()
  `, [
    venue.id, venue.slug, venue.title, venue.city, venue.address, venue.description, venue.rules,
    venue.amenities, venue.paymentMethods, venue.partnerMode,
  ]);
}

async function seedRoom(client: PoolClient, room: (typeof demoRooms)[number]): Promise<void> {
  const closesNextDay = room.closesAtHour >= 24;
  await client.query(`
    insert into rooms (
      id, venue_id, slug, title, room_type, subtitle, description, rules, promotion,
      capacity_min, capacity_max, price_per_hour, minimum_hours, rating_cached, review_count_cached,
      opens_at, closes_at, closes_next_day, buffer_minutes, features, tags, status
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'published')
    on conflict (id) do update set
      venue_id = excluded.venue_id, slug = excluded.slug, title = excluded.title, room_type = excluded.room_type,
      subtitle = excluded.subtitle, description = excluded.description, rules = excluded.rules,
      promotion = excluded.promotion, capacity_min = excluded.capacity_min, capacity_max = excluded.capacity_max,
      price_per_hour = excluded.price_per_hour, minimum_hours = excluded.minimum_hours,
      rating_cached = excluded.rating_cached, review_count_cached = excluded.review_count_cached,
      opens_at = excluded.opens_at, closes_at = excluded.closes_at,
      closes_next_day = excluded.closes_next_day, buffer_minutes = excluded.buffer_minutes,
      features = excluded.features, tags = excluded.tags, updated_at = now()
  `, [
    room.id, room.venueId, room.slug, room.title, room.type, room.subtitle, room.description, room.rules,
    room.promotion, room.capacityMin, room.capacityMax, room.pricePerHour, room.minimumHours,
    room.rating, room.reviewCount, hourToTime(room.opensAtHour), hourToTime(room.closesAtHour),
    closesNextDay, room.bufferMinutes, room.features, room.tags,
  ]);
  await client.query("delete from room_photos where room_id = $1", [room.id]);
  for (const [index, path] of room.photoPaths.entries()) {
    await client.query(`
      insert into room_photos(room_id, original_url, landscape_url, sort_order, is_cover)
      values ($1,$2,$2,$3,$4)
    `, [room.id, path, index, index === 0]);
  }
  await client.query("delete from room_services where room_id = $1", [room.id]);
  for (const [index, service] of room.services.entries()) {
    await client.query(`
      insert into room_services(id, room_id, name, description, price, pricing_unit, active, sort_order)
      values ($1,$2,$3,$4,$5,'booking',true,$6)
    `, [service.id, room.id, service.name, service.description, service.price, index]);
  }
}

async function seedDemoPartner(client: PoolClient): Promise<void> {
  const passwordHash = await hashPassword(demoPartnerPassword);
  const result = await client.query<{ id: string }>(`
    insert into users (id, role, name, email, city, password_hash, password_reset_required)
    values ('50000000-0000-4000-8000-000000000001','partner','Менеджер Kids Loft','manager@kids-loft.ru','Воронеж',$1,false)
    on conflict (email) do update set
      role = 'partner', name = excluded.name, city = excluded.city,
      password_hash = excluded.password_hash, password_reset_required = false,
      blocked_at = null, updated_at = now()
    returning id::text
  `, [passwordHash]);
  await client.query(`
    insert into venue_members (venue_id, user_id, member_role)
    values ($1::uuid,$2::uuid,'manager')
    on conflict (venue_id, user_id) do update set member_role = excluded.member_role
  `, [venueIds.kidsLoft, result.rows[0]!.id]);
}

async function seedDemoAdmin(client: PoolClient): Promise<void> {
  const passwordHash = await hashPassword(demoAdminPassword);
  await client.query(`
    insert into users (id, role, name, email, city, password_hash, password_reset_required)
    values ('50000000-0000-4000-8000-000000000002','admin','Игорь','admin@rooms.ru','Воронеж',$1,false)
    on conflict (email) do update set
      role = 'admin', name = excluded.name, city = excluded.city,
      password_hash = excluded.password_hash, password_reset_required = false,
      blocked_at = null, updated_at = now()
  `, [passwordHash]);
}

async function seedDemoAccountant(client: PoolClient): Promise<void> {
  const passwordHash = await hashPassword(demoAccountantPassword);
  await client.query(`
    insert into users (id, role, name, email, city, password_hash, password_reset_required)
    values ('50000000-0000-4000-8000-000000000003','accountant','Бухгалтер Rooms','accountant@rooms.ru','Воронеж',$1,false)
    on conflict (email) do update set
      role = 'accountant', name = excluded.name, city = excluded.city,
      password_hash = excluded.password_hash, password_reset_required = false,
      blocked_at = null, updated_at = now()
  `, [passwordHash]);
}

async function seedReview(client: PoolClient, review: (typeof demoReviews)[number], index: number): Promise<void> {
  const room = demoRooms.find((item) => item.id === review.roomId);
  if (!room) throw new Error(`Demo review ${review.id} references an unknown room.`);
  const venue = demoVenues.find((item) => item.id === room.venueId);
  if (!venue) throw new Error(`Demo room ${room.id} references an unknown venue.`);
  const suffix = String(index + 1).padStart(12, "0");
  const userId = `40000000-0000-4000-8000-${suffix}`;
  const bookingId = `60000000-0000-4000-8000-${suffix}`;
  const publishedAt = new Date(review.publishedAt);
  const startsAt = new Date(publishedAt.getTime() - 7 * 24 * 60 * 60 * 1000);
  startsAt.setUTCHours(12, 0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + room.minimumHours * 60 * 60 * 1000);
  const total = room.pricePerHour * room.minimumHours;
  const prepayment = Math.ceil(total * 0.3);
  const commission = Math.ceil(total * 0.15);
  const phone = `+7 999 000 00 ${String(index + 1).padStart(2, "0")}`;

  await client.query(`
    insert into users (id, role, name, phone, city, phone_verified_at)
    values ($1, 'client', $2, $3, $4, $5)
    on conflict (id) do update set name = excluded.name, city = excluded.city, updated_at = now()
  `, [userId, `${review.authorName} Демо`, phone, venue.city, startsAt]);
  await client.query(`
    insert into bookings (
      id, public_number, client_id, venue_id, status, client_name, client_phone, city,
      event_type, event_name, guests, starts_at, ends_at, room_total, service_total,
      total, prepayment, commission, partner_amount, remaining_on_site,
      on_site_payment_method, completed_at
    ) values ($1,$2,$3,$4,'completed',$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$13,$14,$15,$16,$17,'card',$12)
    on conflict (id) do update set
      client_id = excluded.client_id, venue_id = excluded.venue_id, status = 'completed',
      client_name = excluded.client_name, client_phone = excluded.client_phone, city = excluded.city,
      event_type = excluded.event_type, event_name = excluded.event_name, guests = excluded.guests,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, room_total = excluded.room_total,
      total = excluded.total, prepayment = excluded.prepayment, commission = excluded.commission,
      partner_amount = excluded.partner_amount, remaining_on_site = excluded.remaining_on_site,
      completed_at = excluded.completed_at, updated_at = now()
  `, [
    bookingId, `DEMO-${String(index + 1).padStart(4, "0")}`, userId, venue.id, review.authorName,
    phone, venue.city, room.type, "Демо-посещение", Math.min(room.capacityMax, 8), startsAt, endsAt,
    total, prepayment, commission, Math.max(0, prepayment - commission), total - prepayment,
  ]);
  await client.query(`
    insert into booking_rooms (booking_id, room_id, title_snapshot, price_per_hour_snapshot, amount, is_primary)
    values ($1,$2,$3,$4,$5,true)
    on conflict (booking_id, room_id) do update set
      title_snapshot = excluded.title_snapshot,
      price_per_hour_snapshot = excluded.price_per_hour_snapshot,
      amount = excluded.amount,
      is_primary = true
  `, [bookingId, room.id, room.title, room.pricePerHour, total]);
  await client.query(`
    insert into reviews (id, booking_id, room_id, client_id, rating, body, status, partner_reply, published_at, created_at)
    values ($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8)
    on conflict (id) do update set
      booking_id = excluded.booking_id, room_id = excluded.room_id, client_id = excluded.client_id,
      rating = excluded.rating, body = excluded.body, status = 'approved',
      partner_reply = excluded.partner_reply, published_at = excluded.published_at
  `, [review.id, bookingId, room.id, userId, review.rating, review.body, review.partnerReply, publishedAt]);
}

const pool = new Pool({ ...postgresPoolConfig(), max: 1, application_name: "rooms-seed" });
const client = await pool.connect();
try {
  await client.query("begin");
  for (const venue of demoVenues) await seedVenue(client, venue);
  await seedDemoPartner(client);
  await seedDemoAdmin(client);
  await seedDemoAccountant(client);
  for (const room of demoRooms) await seedRoom(client, room);
  for (const [index, review] of demoReviews.entries()) await seedReview(client, review, index);
  await client.query("commit");
  console.log(`Seeded ${demoVenues.length} venues, ${demoRooms.length} rooms, ${demoReviews.length} reviews, the demo partner, admin and accountant.`);
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
