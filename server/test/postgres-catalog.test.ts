import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryResultRow } from "pg";
import { PostgresCatalogRepository, type SqlExecutor } from "../src/postgresCatalog.js";
import { createCatalogStorage } from "../src/storage.js";
import type { RoomSearchFilters } from "../src/types.js";

const roomId = "20000000-0000-4000-8000-000000000001";
const venueId = "10000000-0000-4000-8000-000000000001";

class FakeSql implements SqlExecutor {
  calls: Array<{ text: string; values: unknown[] }> = [];

  async query<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: Row[] }> {
    this.calls.push({ text, values });
    let rows: QueryResultRow[] = [];
    if (text.includes("rooms:list-cities")) rows = [{ city: "Воронеж" }, { city: "Москва" }];
    if (text.includes("rooms:city-stats")) rows = [{ city: "Воронеж", published_venues: 3, published_rooms: 5, active_clients_90d: 137 }];
    if (text.includes("rooms:search-rooms") || text.includes("rooms:find-room")) rows = [{
      id: roomId,
      slug: "kosmos",
      venue_id: venueId,
      title: "Комната Космос",
      subtitle: "Детская комната",
      room_type: "kids",
      capacity_min: 1,
      capacity_max: 14,
      price_per_hour: 1600,
      minimum_hours: 2,
      rating: 4.9,
      review_count: 42,
      description: "Комната для праздника.",
      rules: "Можно со своим тортом.",
      promotion: "Подарок имениннику.",
      features: ["kids", "parking", "food"],
      tags: ["аниматоры"],
      opens_at: "10:00:00",
      closes_at: "00:00:00",
      closes_next_day: true,
      buffer_minutes: 0,
      publication_status: "published",
    }];
    if (text.includes("rooms:room-photos")) rows = [
      { room_id: roomId, url: "assets/kids-loft.jpg" },
      { room_id: roomId, url: "assets/banquet-hall.jpg" },
    ];
    if (text.includes("rooms:room-services")) rows = [{
      room_id: roomId,
      id: "30000000-0000-4000-8000-000000000001",
      name: "Аниматор",
      description: "Игровая программа.",
      price: 4000,
    }];
    if (text.includes("rooms:room-schedules")) rows = [{
      room_id: roomId,
      enabled: true,
      opens_at: "11:00:00",
      closes_at: "23:00:00",
      closes_next_day: false,
    }];
    if (text.includes("rooms:room-blocks")) rows = [{ room_id: roomId, start_hour: 18, end_hour: 20 }];
    if (text.includes("rooms:room-reviews")) rows = [{
      id: "50000000-0000-4000-8000-000000000001",
      room_id: roomId,
      author_name: "Марина",
      rating: 5,
      body: "Отличная комната.",
      partner_reply: "Спасибо!",
      published_at: new Date("2026-06-22T12:00:00.000Z"),
    }];
    if (text.includes("rooms:find-venue") || text.includes("rooms:list-venues")) rows = [{
      id: venueId,
      slug: "kids-loft",
      title: "Kids Loft",
      city: "Воронеж",
      address: "ул. Карла Маркса, 54",
      description: "Семейный лофт.",
      rules: "Правила площадки.",
      amenities: ["детская зона", "парковка"],
      publication_status: "published",
      partner_mode: "catalog",
      payment_methods: ["card", "cash"],
    }];
    return { rows: rows as Row[] };
  }
}

test("postgres repository exposes city supply and privacy-safe audience", async () => {
  const repository = new PostgresCatalogRepository(new FakeSql());
  const cities = await repository.listCities();
  assert.deepEqual(cities.map((city) => city.id), ["воронеж", "москва"]);
  assert.equal(cities[0]?.pilot, true);
  const stats = await repository.getCityStats("воронеж");
  assert.equal(stats?.publishedVenues, 3);
  assert.equal(stats?.publishedRooms, 5);
  assert.equal(stats?.activeClientsLabel, "100+");
  assert.equal(stats?.audienceStage, "established");
});

test("postgres repository hydrates room media, services, schedule and reservations", async () => {
  const sql = new FakeSql();
  const repository = new PostgresCatalogRepository(sql);
  const filters: RoomSearchFilters = {
    city: "Воронеж",
    date: "2026-07-18",
    durationMinutes: 120,
    guests: 8,
    type: "kids",
    features: ["parking", "food"],
    maxPricePerHour: 2000,
    sort: "rating",
  };
  const rooms = await repository.searchRooms(filters);
  assert.equal(rooms.length, 1);
  const room = rooms[0];
  assert.ok(room);
  assert.deepEqual(room.photoPaths, ["assets/kids-loft.jpg", "assets/banquet-hall.jpg"]);
  assert.equal(room.services[0]?.name, "Аниматор");
  assert.equal(room.opensAtHour, 11);
  assert.equal(room.closesAtHour, 23);
  assert.deepEqual(room.blockedByDate["2026-07-18"], [[18, 20]]);
  const search = sql.calls.find((call) => call.text.includes("rooms:search-rooms"));
  assert.deepEqual(search?.values, ["Воронеж", 8, "kids", 2000, ["parking", "food"]]);
  assert.match(search?.text ?? "", /r\.capacity_max >= \$2/);
  assert.match(search?.text ?? "", /\$5::text\[\] <@ r\.features/);
});

test("postgres repository returns a public venue and room by stable id", async () => {
  const repository = new PostgresCatalogRepository(new FakeSql());
  const venue = await repository.findVenue(venueId);
  assert.equal(venue?.slug, "kids-loft");
  assert.deepEqual(venue?.amenities, ["детская зона", "парковка"]);
  const room = await repository.findRoom("kosmos", "2026-07-18");
  assert.equal(room?.id, roomId);
  assert.equal(room?.rating, 4.9);
});

test("postgres repository returns privacy-safe published room reviews", async () => {
  const repository = new PostgresCatalogRepository(new FakeSql());
  const reviews = await repository.listRoomReviews("kosmos");
  assert.equal(reviews?.length, 1);
  assert.deepEqual(reviews?.[0], {
    id: "50000000-0000-4000-8000-000000000001",
    roomId,
    authorName: "Марина",
    rating: 5,
    body: "Отличная комната.",
    partnerReply: "Спасибо!",
    publishedAt: "2026-06-22T12:00:00.000Z",
  });
});

test("storage keeps the memory repository when DATABASE_URL is absent", async () => {
  const storage = await createCatalogStorage({});
  assert.equal(storage.repository.storage, "memory");
  await storage.close();
});

test("external payments cannot start without durable PostgreSQL state", async () => {
  await assert.rejects(
    () => createCatalogStorage({
      PAYMENT_PROVIDER: "sber",
      SBER_API_BASE_URL: "https://ecomtest.sberbank.ru",
      SBER_USERNAME: "rooms-test",
      SBER_PASSWORD: "rooms-test-password",
    }),
    /DATABASE_URL is required/,
  );
});

test("storage fails closed when a configured PostgreSQL database is unavailable", async () => {
  await assert.rejects(
    () => createCatalogStorage({
      DATABASE_URL: "postgresql://rooms:invalid@127.0.0.1:1/rooms",
      DATABASE_CONNECT_TIMEOUT_MS: "100",
    }),
    /could not connect to PostgreSQL/,
  );
});
