import type { QueryResultRow } from "pg";
import type { CatalogRepository } from "./catalog.js";
import type { City, CityStats, HourInterval, PaymentMethod, PublicReview, PublicationStatus, Room, RoomSearchFilters, RoomService, Venue } from "./types.js";

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

interface VenueRow extends QueryResultRow {
  id: string;
  slug: string;
  title: string;
  city: string;
  address: string;
  description: string | null;
  rules: string | null;
  amenities: string[] | null;
  publication_status: PublicationStatus;
  partner_mode: "catalog" | "crm";
  payment_methods: PaymentMethod[] | null;
}

interface RoomRow extends QueryResultRow {
  id: string;
  slug: string;
  venue_id: string;
  title: string;
  subtitle: string | null;
  room_type: string;
  capacity_min: number;
  capacity_max: number;
  price_per_hour: number | string;
  minimum_hours: number | string;
  rating: number | string;
  review_count: number | string;
  description: string | null;
  rules: string | null;
  promotion: string | null;
  features: string[] | null;
  tags: string[] | null;
  opens_at: string;
  closes_at: string;
  closes_next_day: boolean;
  buffer_minutes: 0 | 15 | 30 | 45 | 60;
  publication_status: PublicationStatus;
}

interface PhotoRow extends QueryResultRow {
  room_id: string;
  url: string;
}

interface ServiceRow extends QueryResultRow {
  room_id: string;
  id: string;
  name: string;
  description: string | null;
  price: number | string;
}

interface ScheduleRow extends QueryResultRow {
  room_id: string;
  enabled: boolean;
  opens_at: string | null;
  closes_at: string | null;
  closes_next_day: boolean | null;
}

interface BlockRow extends QueryResultRow {
  room_id: string;
  start_hour: number | string;
  end_hour: number | string;
}

interface ReviewRow extends QueryResultRow {
  id: string | null;
  room_id: string;
  author_name: string | null;
  rating: number | string | null;
  body: string | null;
  partner_reply: string | null;
  published_at: Date | string | null;
}

const ROOM_SELECT = `
  select
    r.id::text, r.slug, r.venue_id::text, r.title, r.subtitle, r.room_type,
    r.capacity_min, r.capacity_max, r.price_per_hour::float8, r.minimum_hours::float8,
    case when r.review_count_cached > 0 then r.rating_cached else coalesce(review_metrics.rating, 0) end::float8 as rating,
    case when r.review_count_cached > 0 then r.review_count_cached else coalesce(review_metrics.review_count, 0) end as review_count,
    r.description, r.rules, r.promotion, r.features, r.tags,
    r.opens_at::text, r.closes_at::text, r.closes_next_day, r.buffer_minutes,
    r.status as publication_status
  from rooms r
  join venues v on v.id = r.venue_id
  left join lateral (
    select avg(rv.rating)::float8 as rating, count(*)::integer as review_count
    from reviews rv
    where rv.room_id = r.id and rv.status = 'approved'
  ) review_metrics on true
`;

function cityId(name: string): string {
  return name.toLocaleLowerCase("ru-RU").replace(/\s+/g, "-");
}

function audienceLabel(count: number): string | null {
  const threshold = [1000, 500, 200, 100, 50, 20].find((value) => count >= value);
  return threshold ? `${threshold.toLocaleString("ru-RU")}+` : null;
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clockHour(value: string, nextDay = false): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return numeric(hours) + numeric(minutes) / 60 + (nextDay ? 24 : 0);
}

function venueFromRow(row: VenueRow): Venue {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    city: row.city,
    address: row.address,
    description: row.description ?? "",
    rules: row.rules ?? "",
    amenities: row.amenities ?? [],
    publicationStatus: row.publication_status,
    partnerMode: row.partner_mode,
    paymentMethods: row.payment_methods ?? ["card", "cash"],
  };
}

export class PostgresCatalogRepository implements CatalogRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly sql: SqlExecutor) {}

  async listCities(): Promise<City[]> {
    const result = await this.sql.query<{ city: string }>(`/* rooms:list-cities */
      select distinct v.city
      from venues v
      where v.publication_status = 'published'
        and v.verification_status = 'verified'
        and v.cabinet_status = 'active'
        and v.partner_mode = 'catalog'
      order by v.city
    `);
    return result.rows.map(({ city }) => ({ id: cityId(city), name: city, active: true, pilot: city === "Воронеж" }));
  }

  async getCityStats(idOrName: string): Promise<CityStats | null> {
    const result = await this.sql.query<{
      city: string;
      published_venues: number | string;
      published_rooms: number | string;
      active_clients_90d: number | string;
    }>(`/* rooms:city-stats */
      with supply as (
        select v.city, count(distinct v.id)::integer as published_venues,
          count(distinct r.id) filter (where r.status = 'published')::integer as published_rooms
        from venues v
        left join rooms r on r.venue_id = v.id
        where v.publication_status = 'published'
          and v.verification_status = 'verified'
          and v.cabinet_status = 'active'
          and v.partner_mode = 'catalog'
        group by v.city
      )
      select supply.city, supply.published_venues, supply.published_rooms,
        coalesce(stats.active_clients_90d, 0)::integer as active_clients_90d
      from supply
      left join city_statistics stats on lower(stats.city) = lower(supply.city)
      where lower(supply.city) = lower($1)
        or regexp_replace(lower(supply.city), '\\s+', '-', 'g') = lower($1)
      limit 1
    `, [idOrName.trim()]);
    const row = result.rows[0];
    if (!row) return null;
    const activeClients = numeric(row.active_clients_90d);
    const city: City = { id: cityId(row.city), name: row.city, active: true, pilot: row.city === "Воронеж" };
    return {
      city,
      publishedVenues: numeric(row.published_venues),
      publishedRooms: numeric(row.published_rooms),
      activeClientsLabel: audienceLabel(activeClients),
      audienceStage: activeClients >= 100 ? "established" : activeClients >= 20 ? "growing" : "launching",
      updatedAt: new Date().toISOString(),
    };
  }

  async listVenues(): Promise<Venue[]> {
    const result = await this.sql.query<VenueRow>(`/* rooms:list-venues */
      select v.id::text, v.slug, v.title, v.city, v.address, v.description, v.rules,
        v.amenities, v.publication_status, v.partner_mode, v.payment_methods
      from venues v
      where v.publication_status = 'published'
        and v.verification_status = 'verified'
        and v.cabinet_status = 'active'
        and v.partner_mode = 'catalog'
      order by v.city, v.title
    `);
    return result.rows.map(venueFromRow);
  }

  async searchRooms(filters: RoomSearchFilters): Promise<Room[]> {
    const values: unknown[] = [filters.city];
    const conditions = [
      "v.city = $1",
      "r.status = 'published'",
      "v.publication_status = 'published'",
      "v.verification_status = 'verified'",
      "v.cabinet_status = 'active'",
      "v.partner_mode = 'catalog'",
    ];
    const add = (condition: string, value: unknown) => {
      values.push(value);
      conditions.push(condition.replace("?", `$${values.length}`));
    };
    if (filters.guests !== undefined) add("r.capacity_max >= ?", filters.guests);
    if (filters.type && filters.type !== "any") add("r.room_type = ?", filters.type);
    if (filters.maxPricePerHour !== undefined && filters.maxPricePerHour > 0) add("r.price_per_hour <= ?", filters.maxPricePerHour);
    if (filters.features.length) add("?::text[] <@ r.features", filters.features);
    const orderBy = {
      rating: "rating desc, review_count desc, r.title",
      price: "r.price_per_hour asc, rating desc, r.title",
      capacity: "r.capacity_max desc, rating desc, r.title",
    }[filters.sort];
    const result = await this.sql.query<RoomRow>(`/* rooms:search-rooms */
      ${ROOM_SELECT}
      where ${conditions.join("\n        and ")}
      order by ${orderBy}
    `, values);
    return this.hydrateRooms(result.rows, filters.date);
  }

  async findRoom(idOrSlug: string, date?: string): Promise<Room | null> {
    const result = await this.sql.query<RoomRow>(`/* rooms:find-room */
      ${ROOM_SELECT}
      where (r.id::text = $1 or r.slug = $1)
        and r.status = 'published'
        and v.publication_status = 'published'
        and v.verification_status = 'verified'
        and v.cabinet_status = 'active'
        and v.partner_mode = 'catalog'
      limit 1
    `, [idOrSlug]);
    if (!result.rows.length) return null;
    return (await this.hydrateRooms(result.rows, date))[0] ?? null;
  }

  async listRoomReviews(idOrSlug: string): Promise<PublicReview[] | null> {
    const result = await this.sql.query<ReviewRow>(`/* rooms:room-reviews */
      with target_room as (
        select r.id
        from rooms r
        join venues v on v.id = r.venue_id
        where (r.id::text = $1 or r.slug = $1)
          and r.status = 'published'
          and v.publication_status = 'published'
          and v.verification_status = 'verified'
          and v.cabinet_status = 'active'
          and v.partner_mode = 'catalog'
        limit 1
      )
      select rv.id::text, target_room.id::text as room_id,
        coalesce(nullif(split_part(trim(u.name), ' ', 1), ''), 'Гость Rooms') as author_name,
        rv.rating, rv.body, rv.partner_reply, rv.published_at
      from target_room
      left join reviews rv
        on rv.room_id = target_room.id
        and rv.status = 'approved'
        and rv.published_at is not null
      left join users u on u.id = rv.client_id
      order by rv.published_at desc nulls last, rv.created_at desc nulls last
    `, [idOrSlug]);
    if (!result.rows.length) return null;
    return result.rows.filter((row) => row.id !== null).map((row) => ({
      id: row.id!,
      roomId: row.room_id,
      authorName: row.author_name ?? "Гость Rooms",
      rating: numeric(row.rating),
      body: row.body,
      partnerReply: row.partner_reply,
      publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
    }));
  }

  async findVenue(id: string): Promise<Venue | null> {
    const result = await this.sql.query<VenueRow>(`/* rooms:find-venue */
      select v.id::text, v.slug, v.title, v.city, v.address, v.description, v.rules,
        v.amenities, v.publication_status, v.partner_mode, v.payment_methods
      from venues v
      where v.id::text = $1
        and v.publication_status = 'published'
        and v.verification_status = 'verified'
        and v.cabinet_status = 'active'
        and v.partner_mode = 'catalog'
      limit 1
    `, [id]);
    return result.rows[0] ? venueFromRow(result.rows[0]) : null;
  }

  private async hydrateRooms(rows: RoomRow[], date?: string): Promise<Room[]> {
    if (!rows.length) return [];
    const roomIds = rows.map((row) => row.id);
    const [photosResult, servicesResult, schedules, blocks] = await Promise.all([
      this.sql.query<PhotoRow>(`/* rooms:room-photos */
        select p.room_id::text, coalesce(p.landscape_url, p.original_url) as url
        from room_photos p
        where p.room_id = any($1::uuid[]) and p.status = 'published'
        order by p.room_id, p.is_cover desc, p.sort_order, p.created_at
      `, [roomIds]),
      this.sql.query<ServiceRow>(`/* rooms:room-services */
        select s.room_id::text, s.id::text, s.name, s.description, s.price::float8
        from room_services s
        where s.room_id = any($1::uuid[]) and s.active
        order by s.room_id, s.sort_order, s.name
      `, [roomIds]),
      date ? this.loadSchedules(roomIds, date) : Promise.resolve(new Map<string, ScheduleRow>()),
      date ? this.loadBlocks(roomIds, date) : Promise.resolve(new Map<string, HourInterval[]>()),
    ]);
    const photos = new Map<string, string[]>();
    for (const photo of photosResult.rows) photos.set(photo.room_id, [...(photos.get(photo.room_id) ?? []), photo.url]);
    const services = new Map<string, RoomService[]>();
    for (const service of servicesResult.rows) {
      const item: RoomService = { id: service.id, name: service.name, description: service.description, price: numeric(service.price) };
      services.set(service.room_id, [...(services.get(service.room_id) ?? []), item]);
    }
    return rows.map((row) => {
      const schedule = schedules.get(row.id);
      const enabled = schedule?.enabled ?? true;
      const opensAtHour = enabled ? clockHour(schedule?.opens_at ?? row.opens_at) : 0;
      const closesAtHour = enabled
        ? clockHour(schedule?.closes_at ?? row.closes_at, schedule?.closes_next_day ?? row.closes_next_day)
        : 0;
      return {
        id: row.id,
        slug: row.slug,
        venueId: row.venue_id,
        title: row.title,
        subtitle: row.subtitle ?? "",
        type: row.room_type,
        capacityMin: numeric(row.capacity_min),
        capacityMax: numeric(row.capacity_max),
        pricePerHour: numeric(row.price_per_hour),
        minimumHours: numeric(row.minimum_hours),
        rating: numeric(row.rating),
        reviewCount: numeric(row.review_count),
        description: row.description ?? "",
        rules: row.rules ?? "",
        promotion: row.promotion,
        features: row.features ?? [],
        tags: row.tags ?? [],
        photoPaths: photos.get(row.id) ?? [],
        services: services.get(row.id) ?? [],
        opensAtHour,
        closesAtHour,
        bufferMinutes: row.buffer_minutes,
        defaultBlocked: [],
        blockedByDate: date ? { [date]: blocks.get(row.id) ?? [] } : {},
        publicationStatus: row.publication_status,
      };
    });
  }

  private async loadSchedules(roomIds: string[], date: string): Promise<Map<string, ScheduleRow>> {
    const result = await this.sql.query<ScheduleRow>(`/* rooms:room-schedules */
      select r.id::text as room_id,
        case
          when special.mode = 'closed' then false
          when special.mode = 'custom' then special.opens_at is not null and special.closes_at is not null
          when weekly.venue_id is not null then weekly.enabled
          else true
        end as enabled,
        case when special.mode = 'custom' then special.opens_at::text
          when special.mode = 'closed' then null
          when weekly.venue_id is not null then weekly.opens_at::text
          else null end as opens_at,
        case when special.mode = 'custom' then special.closes_at::text
          when special.mode = 'closed' then null
          when weekly.venue_id is not null then weekly.closes_at::text
          else null end as closes_at,
        case when special.mode = 'custom' then special.closes_next_day
          when special.mode = 'closed' then false
          when weekly.venue_id is not null then weekly.closes_next_day
          else null end as closes_next_day
      from rooms r
      left join venue_schedule_exceptions special
        on special.venue_id = r.venue_id and special.local_date = $1::date
      left join venue_week_schedule weekly
        on weekly.venue_id = r.venue_id and weekly.weekday = extract(isodow from $1::date)::smallint
      where r.id = any($2::uuid[])
    `, [date, roomIds]);
    return new Map(result.rows.map((row) => [row.room_id, row]));
  }

  private async loadBlocks(roomIds: string[], date: string): Promise<Map<string, HourInterval[]>> {
    const result = await this.sql.query<BlockRow>(`/* rooms:room-blocks */
      select reservation.room_id::text,
        greatest(0, extract(epoch from ((lower(reservation.period) at time zone 'Europe/Moscow') - $1::date::timestamp)) / 3600)::float8 as start_hour,
        least(48, extract(epoch from ((upper(reservation.period) at time zone 'Europe/Moscow') - $1::date::timestamp)) / 3600)::float8 as end_hour
      from room_reservations reservation
      where reservation.room_id = any($2::uuid[])
        and reservation.active
        and (reservation.expires_at is null or reservation.expires_at > now())
        and reservation.period && tstzrange(
          $1::date::timestamp at time zone 'Europe/Moscow',
          ($1::date + 2)::timestamp at time zone 'Europe/Moscow',
          '[)'
        )
      order by reservation.room_id, lower(reservation.period)
    `, [date, roomIds]);
    const blocks = new Map<string, HourInterval[]>();
    for (const row of result.rows) {
      const interval: HourInterval = [numeric(row.start_hour), numeric(row.end_hour)];
      blocks.set(row.room_id, [...(blocks.get(row.room_id) ?? []), interval]);
    }
    return blocks;
  }
}
