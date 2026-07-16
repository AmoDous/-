import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { MemoryBookingRepository, type BookingRepository } from "./bookings.js";
import type { CatalogRepository } from "./catalog.js";
import type { HourInterval, Room } from "./types.js";

export type PartnerReservationType = "manual_booking" | "technical";
export type TechnicalCategory = "technical" | "service" | "private";
export type ManualReservationSource = "phone" | "whatsapp" | "telegram" | "walk_in" | "other";
export type PartnerReservationStatus = "active" | "cancelled";

export interface ReservationHistoryItem {
  title: string;
  details: string;
  created: string;
}

export interface PartnerReservation {
  id: string;
  venueId: string;
  roomId: string;
  roomSlug: string;
  roomTitle: string;
  type: PartnerReservationType;
  category: TechnicalCategory | null;
  status: PartnerReservationStatus;
  startsAt: string;
  endsAt: string;
  clientName: string | null;
  clientPhone: string | null;
  guests: number | null;
  amount: number;
  source: ManualReservationSource | null;
  comment: string;
  cancellationReason: string | null;
  bufferMinutes: number;
  history: ReservationHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PartnerReservationInput {
  roomId: string;
  type: PartnerReservationType;
  category?: TechnicalCategory;
  startsAt: string;
  endsAt: string;
  clientName?: string | null;
  clientPhone?: string | null;
  guests?: number | null;
  amount?: number;
  source?: ManualReservationSource | null;
  comment?: string;
}

export interface PartnerReservationQuery {
  roomId?: string;
  dateFrom?: string;
  dateTo?: string;
  includeCancelled?: boolean;
}

export interface PartnerReservationRepository {
  readonly storage: "memory" | "postgresql";
  listByPartner(partnerId: string, query: PartnerReservationQuery): Promise<PartnerReservation[]>;
  findByPartner(partnerId: string, reservationId: string): Promise<PartnerReservation | null>;
  create(partnerId: string, input: PartnerReservationInput): Promise<PartnerReservation>;
  update(partnerId: string, reservationId: string, input: PartnerReservationInput): Promise<PartnerReservation | null>;
  cancel(partnerId: string, reservationId: string, reason: string): Promise<PartnerReservation | null>;
  restore(partnerId: string, reservationId: string): Promise<PartnerReservation | null>;
  deleteTechnical(partnerId: string, reservationId: string): Promise<boolean>;
  blocksByDate(roomIds: string[], date: string): Promise<Record<string, HourInterval[]>>;
}

export class ReservationActionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function ownerId(id: string): string {
  return `manual:${id}`;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newDetails(input: PartnerReservationInput, now: string): ReservationDetails {
  const manual = input.type === "manual_booking";
  return {
    status: "active",
    category: manual ? null : input.category ?? "technical",
    clientName: manual ? input.clientName?.trim() || null : null,
    clientPhone: manual ? input.clientPhone?.trim() || null : null,
    guests: manual ? Math.max(1, Number(input.guests) || 1) : null,
    amount: manual ? Math.max(0, Number(input.amount) || 0) : 0,
    source: manual ? input.source ?? "phone" : null,
    comment: input.comment?.trim() ?? "",
    cancellationReason: null,
    updatedAt: now,
    history: [{
      title: manual ? "Ручная бронь создана" : "Занятость добавлена",
      details: manual ? "Добавлена партнёром из внешнего источника" : "Интервал закрыт партнёром",
      created: now,
    }],
  };
}

function updatedDetails(previous: ReservationDetails, input: PartnerReservationInput, moved: boolean, now: string): ReservationDetails {
  const manual = input.type === "manual_booking";
  return {
    ...previous,
    category: manual ? null : input.category ?? "technical",
    clientName: manual ? input.clientName?.trim() || null : null,
    clientPhone: manual ? input.clientPhone?.trim() || null : null,
    guests: manual ? Math.max(1, Number(input.guests) || 1) : null,
    amount: manual ? Math.max(0, Number(input.amount) || 0) : 0,
    source: manual ? input.source ?? "phone" : null,
    comment: input.comment?.trim() ?? "",
    updatedAt: now,
    history: [...previous.history, {
      title: moved ? "Запись перенесена" : "Данные записи изменены",
      details: moved ? "Изменены помещение, дата или время" : "Обновлены данные партнёром",
      created: now,
    }],
  };
}

function localHour(value: string, baseDate: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const dayOffset = Math.round((Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${baseDate}T00:00:00Z`)) / 86_400_000);
  return dayOffset * 24 + Number(parts.hour) + Number(parts.minute) / 60;
}

function moscowDate(value: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function recordBlocks(record: PartnerReservation, date: string): HourInterval[] {
  if (record.status !== "active") return [];
  const padding = record.bufferMinutes / 60;
  const start = Math.max(0, localHour(record.startsAt, date) - padding);
  const end = Math.min(48, localHour(record.endsAt, date) + padding);
  return end > 0 && start < 48 && end > start ? [[start, end]] : [];
}

interface MemoryReservationRecord extends PartnerReservation {}

export class MemoryPartnerReservationRepository implements PartnerReservationRepository {
  readonly storage = "memory" as const;
  private readonly records = new Map<string, MemoryReservationRecord>();

  constructor(private readonly bookings: BookingRepository, private readonly catalog: CatalogRepository) {}

  async listByPartner(partnerId: string, query: PartnerReservationQuery): Promise<PartnerReservation[]> {
    const venue = await this.bookings.getPartnerVenue(partnerId);
    if (!venue) return [];
    const fromTimestamp = query.dateFrom ? Date.parse(`${query.dateFrom}T00:00:00+03:00`) : null;
    const toTimestamp = query.dateTo ? Date.parse(`${query.dateTo}T00:00:00+03:00`) + 86_400_000 : null;
    return [...this.records.values()]
      .filter((record) => record.venueId === venue.id)
      .filter((record) => !query.roomId || record.roomId === query.roomId)
      .filter((record) => query.includeCancelled !== false || record.status === "active")
      .filter((record) => fromTimestamp === null || Date.parse(record.endsAt) > fromTimestamp)
      .filter((record) => toTimestamp === null || Date.parse(record.startsAt) < toTimestamp)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
      .map((record) => structuredClone(record));
  }

  async findByPartner(partnerId: string, reservationId: string): Promise<PartnerReservation | null> {
    const record = await this.owned(partnerId, reservationId);
    return record ? structuredClone(record) : null;
  }

  async create(partnerId: string, input: PartnerReservationInput): Promise<PartnerReservation> {
    const target = await this.authorize(partnerId, input.roomId);
    const id = randomUUID();
    const start = new Date(input.startsAt).getTime();
    const end = new Date(input.endsAt).getTime();
    const padding = target.room.bufferMinutes * 60_000;
    this.assertCatalogFree(target.room, input.startsAt, input.endsAt);
    this.assertFree(target.bookingRepository, input.roomId, start - padding, end + padding, ownerId(id));
    const now = nowIso();
    const details = newDetails(input, now);
    const record: MemoryReservationRecord = {
      id,
      venueId: target.venueId,
      roomId: target.room.id,
      roomSlug: target.room.slug,
      roomTitle: target.room.title,
      type: input.type,
      category: details.category,
      status: "active",
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      clientName: details.clientName,
      clientPhone: details.clientPhone,
      guests: details.guests,
      amount: details.amount,
      source: details.source,
      comment: details.comment,
      cancellationReason: null,
      bufferMinutes: target.room.bufferMinutes,
      history: details.history,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    target.bookingRepository?.setExternalReservation(ownerId(id), input.roomId, start - padding, end + padding);
    return structuredClone(record);
  }

  async update(partnerId: string, reservationId: string, input: PartnerReservationInput): Promise<PartnerReservation | null> {
    const current = await this.owned(partnerId, reservationId);
    if (!current) return null;
    if (current.type !== input.type) throw new ReservationActionError(409, "RESERVATION_TYPE_IMMUTABLE", "Тип записи календаря нельзя изменить после создания.");
    const target = await this.authorize(partnerId, input.roomId);
    const start = new Date(input.startsAt).getTime();
    const end = new Date(input.endsAt).getTime();
    const padding = target.room.bufferMinutes * 60_000;
    this.assertCatalogFree(target.room, input.startsAt, input.endsAt);
    if (current.status === "active") this.assertFree(target.bookingRepository, input.roomId, start - padding, end + padding, ownerId(reservationId));
    const now = nowIso();
    const previous = detailsFromRecord(current);
    const moved = current.roomId !== input.roomId || current.startsAt !== new Date(start).toISOString() || current.endsAt !== new Date(end).toISOString();
    const details = updatedDetails(previous, input, moved, now);
    const next: MemoryReservationRecord = {
      ...current,
      roomId: target.room.id,
      roomSlug: target.room.slug,
      roomTitle: target.room.title,
      type: input.type,
      category: details.category,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      clientName: details.clientName,
      clientPhone: details.clientPhone,
      guests: details.guests,
      amount: details.amount,
      source: details.source,
      comment: details.comment,
      history: details.history,
      bufferMinutes: target.room.bufferMinutes,
      updatedAt: now,
    };
    this.records.set(reservationId, next);
    target.bookingRepository?.removeExternalReservation(ownerId(reservationId));
    if (next.status === "active") target.bookingRepository?.setExternalReservation(ownerId(reservationId), next.roomId, start - padding, end + padding);
    return structuredClone(next);
  }

  async cancel(partnerId: string, reservationId: string, reason: string): Promise<PartnerReservation | null> {
    const record = await this.owned(partnerId, reservationId);
    if (!record) return null;
    if (record.status === "cancelled") return structuredClone(record);
    const now = nowIso();
    record.status = "cancelled";
    record.cancellationReason = reason;
    record.updatedAt = now;
    record.history.push({ title: "Бронь отменена", details: reason, created: now });
    if (this.bookings instanceof MemoryBookingRepository) this.bookings.removeExternalReservation(ownerId(reservationId));
    return structuredClone(record);
  }

  async restore(partnerId: string, reservationId: string): Promise<PartnerReservation | null> {
    const record = await this.owned(partnerId, reservationId);
    if (!record) return null;
    if (record.status === "active") return structuredClone(record);
    const target = await this.authorize(partnerId, record.roomId);
    const start = new Date(record.startsAt).getTime();
    const end = new Date(record.endsAt).getTime();
    const padding = record.bufferMinutes * 60_000;
    this.assertCatalogFree(target.room, record.startsAt, record.endsAt);
    this.assertFree(target.bookingRepository, record.roomId, start - padding, end + padding, ownerId(reservationId));
    const now = nowIso();
    record.status = "active";
    record.cancellationReason = null;
    record.updatedAt = now;
    record.history.push({ title: "Бронь восстановлена", details: "Интервал снова занимает календарь", created: now });
    target.bookingRepository?.setExternalReservation(ownerId(reservationId), record.roomId, start - padding, end + padding);
    return structuredClone(record);
  }

  async deleteTechnical(partnerId: string, reservationId: string): Promise<boolean> {
    const record = await this.owned(partnerId, reservationId);
    if (!record) return false;
    if (record.type === "manual_booking") throw new ReservationActionError(409, "RESERVATION_CANCEL_REQUIRED", "Ручную бронь нужно отменить с указанием причины.");
    this.records.delete(reservationId);
    if (this.bookings instanceof MemoryBookingRepository) this.bookings.removeExternalReservation(ownerId(reservationId));
    return true;
  }

  async blocksByDate(roomIds: string[], date: string): Promise<Record<string, HourInterval[]>> {
    const selected = new Set(roomIds);
    const blocks: Record<string, HourInterval[]> = {};
    for (const record of this.records.values()) {
      if (!selected.has(record.roomId)) continue;
      const intervals = recordBlocks(record, date);
      if (intervals.length) blocks[record.roomId] = [...(blocks[record.roomId] ?? []), ...intervals];
    }
    return blocks;
  }

  private async authorize(partnerId: string, roomId: string) {
    const [venue, room] = await Promise.all([this.bookings.getPartnerVenue(partnerId), this.catalog.findRoom(roomId)]);
    if (!venue || !room || room.venueId !== venue.id) throw new ReservationActionError(404, "PARTNER_ROOM_NOT_FOUND", "Помещение не найдено в кабинете этой площадки.");
    return { venueId: venue.id, room, bookingRepository: this.bookings instanceof MemoryBookingRepository ? this.bookings : null };
  }

  private async owned(partnerId: string, reservationId: string): Promise<MemoryReservationRecord | null> {
    const venue = await this.bookings.getPartnerVenue(partnerId);
    const record = this.records.get(reservationId);
    return venue && record?.venueId === venue.id ? record : null;
  }

  private assertFree(bookings: MemoryBookingRepository | null, roomId: string, start: number, end: number, excludeId: string): void {
    if (bookings?.hasReservationConflict(roomId, start, end, excludeId)) {
      throw new ReservationActionError(409, "SLOT_CONFLICT", "Интервал пересекается с другой бронью или технической занятостью.");
    }
  }

  private assertCatalogFree(room: Room, startsAt: string, endsAt: string): void {
    const date = moscowDate(startsAt);
    const padding = room.bufferMinutes / 60;
    const start = localHour(startsAt, date) - padding;
    const end = localHour(endsAt, date) + padding;
    const intervals = [...room.defaultBlocked, ...(room.blockedByDate[date] ?? [])];
    if (intervals.some(([blockedStart, blockedEnd]) => start < blockedEnd && end > blockedStart)) {
      throw new ReservationActionError(409, "SLOT_CONFLICT", "Интервал пересекается с другой бронью или технической занятостью.");
    }
  }
}

interface ReservationDetails {
  status: PartnerReservationStatus;
  category: TechnicalCategory | null;
  clientName: string | null;
  clientPhone: string | null;
  guests: number | null;
  amount: number;
  source: ManualReservationSource | null;
  comment: string;
  cancellationReason: string | null;
  updatedAt: string;
  history: ReservationHistoryItem[];
}

interface ReservationRow extends QueryResultRow {
  id: string;
  venue_id: string;
  room_id: string;
  room_slug: string;
  room_title: string;
  source_type: PartnerReservationType;
  starts_at: Date | string;
  ends_at: Date | string;
  active: boolean;
  details: Partial<ReservationDetails> | null;
  buffer_minutes: number;
  created_at: Date | string;
}

interface OwnedRoomRow extends QueryResultRow {
  id: string;
  venue_id: string;
  slug: string;
  title: string;
  buffer_minutes: number;
}

function normalizedDetails(row: ReservationRow): ReservationDetails {
  const details = row.details ?? {};
  return {
    status: row.active ? "active" : "cancelled",
    category: details.category ?? (row.source_type === "technical" ? "technical" : null),
    clientName: details.clientName ?? null,
    clientPhone: details.clientPhone ?? null,
    guests: details.guests === null || details.guests === undefined ? null : Math.max(1, asNumber(details.guests)),
    amount: Math.max(0, asNumber(details.amount)),
    source: details.source ?? null,
    comment: details.comment ?? "",
    cancellationReason: details.cancellationReason ?? null,
    updatedAt: details.updatedAt ?? asIso(row.created_at),
    history: Array.isArray(details.history) ? details.history : [],
  };
}

function fromRow(row: ReservationRow): PartnerReservation {
  const details = normalizedDetails(row);
  return {
    id: row.id,
    venueId: row.venue_id,
    roomId: row.room_id,
    roomSlug: row.room_slug,
    roomTitle: row.room_title,
    type: row.source_type,
    category: details.category,
    status: details.status,
    startsAt: asIso(row.starts_at),
    endsAt: asIso(row.ends_at),
    clientName: details.clientName,
    clientPhone: details.clientPhone,
    guests: details.guests,
    amount: details.amount,
    source: details.source,
    comment: details.comment,
    cancellationReason: details.cancellationReason,
    bufferMinutes: Number(row.buffer_minutes) || 0,
    history: details.history,
    createdAt: asIso(row.created_at),
    updatedAt: details.updatedAt,
  };
}

function detailsFromRecord(record: PartnerReservation): ReservationDetails {
  return {
    status: record.status,
    category: record.category,
    clientName: record.clientName,
    clientPhone: record.clientPhone,
    guests: record.guests,
    amount: record.amount,
    source: record.source,
    comment: record.comment,
    cancellationReason: record.cancellationReason,
    updatedAt: record.updatedAt,
    history: structuredClone(record.history),
  };
}

export class PostgresPartnerReservationRepository implements PartnerReservationRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly pool: Pool) {}

  async listByPartner(partnerId: string, query: PartnerReservationQuery): Promise<PartnerReservation[]> {
    const result = await this.pool.query<ReservationRow>(`/* rooms:list-partner-reservations */
      select reservation.id::text, room.venue_id::text, room.id::text as room_id,
        room.slug as room_slug, room.title as room_title, reservation.source_type,
        lower(reservation.period) as starts_at, upper(reservation.period) as ends_at,
        reservation.active, reservation.details, room.buffer_minutes, reservation.created_at
      from room_reservations reservation
      join rooms room on room.id = reservation.room_id
      join venue_members member on member.venue_id = room.venue_id and member.user_id = $1::uuid
      where reservation.source_type in ('manual_booking','technical')
        and ($2::uuid is null or room.id = $2::uuid)
        and ($3::date is null or upper(reservation.period) > $3::date::timestamp at time zone 'Europe/Moscow')
        and ($4::date is null or lower(reservation.period) < ($4::date + 1)::timestamp at time zone 'Europe/Moscow')
        and ($5::boolean or reservation.active)
      order by lower(reservation.period), reservation.created_at
      limit 500
    `, [partnerId, query.roomId ?? null, query.dateFrom ?? null, query.dateTo ?? null, query.includeCancelled !== false]);
    return result.rows.map(fromRow);
  }

  async findByPartner(partnerId: string, reservationId: string): Promise<PartnerReservation | null> {
    return this.findOwned(partnerId, reservationId);
  }

  async create(partnerId: string, input: PartnerReservationInput): Promise<PartnerReservation> {
    const client = await this.pool.connect();
    const id = randomUUID();
    try {
      await client.query("begin");
      const room = await this.ownedRoom(client, partnerId, input.roomId);
      if (!room) throw new ReservationActionError(404, "PARTNER_ROOM_NOT_FOUND", "Помещение не найдено в кабинете этой площадки.");
      const now = nowIso();
      const details = newDetails(input, now);
      await client.query(`
        insert into room_reservations (id, room_id, source_type, source_id, period, active, details, created_by)
        values ($1::uuid,$2::uuid,$3::reservation_source,$1::uuid,tstzrange($4::timestamptz,$5::timestamptz,'[)'),true,$6::jsonb,$7::uuid)
      `, [id, room.id, input.type, input.startsAt, input.endsAt, JSON.stringify(details), partnerId]);
      await this.insertBuffers(client, id, room, input.startsAt, input.endsAt, partnerId);
      await this.audit(client, partnerId, "reservation_create", id, null, { ...input, details });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      this.rethrowConflict(error);
    } finally {
      client.release();
    }
    return (await this.findOwned(partnerId, id))!;
  }

  async update(partnerId: string, reservationId: string, input: PartnerReservationInput): Promise<PartnerReservation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const previousRow = await this.ownedReservation(client, partnerId, reservationId);
      if (!previousRow) {
        await client.query("rollback");
        return null;
      }
      const room = await this.ownedRoom(client, partnerId, input.roomId);
      if (!room) throw new ReservationActionError(404, "PARTNER_ROOM_NOT_FOUND", "Помещение не найдено в кабинете этой площадки.");
      const previous = fromRow(previousRow);
      if (previous.type !== input.type) throw new ReservationActionError(409, "RESERVATION_TYPE_IMMUTABLE", "Тип записи календаря нельзя изменить после создания.");
      const moved = previous.roomId !== input.roomId || previous.startsAt !== asIso(input.startsAt) || previous.endsAt !== asIso(input.endsAt);
      const details = updatedDetails(normalizedDetails(previousRow), input, moved, nowIso());
      await client.query("delete from room_reservations where source_type = 'buffer' and source_id = $1::uuid", [reservationId]);
      await client.query("update room_reservations set active = false where id = $1::uuid", [reservationId]);
      await client.query(`
        update room_reservations
        set room_id = $2::uuid, source_type = $3::reservation_source,
          period = tstzrange($4::timestamptz,$5::timestamptz,'[)'), details = $6::jsonb, active = $7
        where id = $1::uuid
      `, [reservationId, room.id, input.type, input.startsAt, input.endsAt, JSON.stringify(details), previous.status === "active"]);
      if (previous.status === "active") await this.insertBuffers(client, reservationId, room, input.startsAt, input.endsAt, partnerId);
      await this.audit(client, partnerId, "reservation_update", reservationId, previous, { ...input, details });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      this.rethrowConflict(error);
    } finally {
      client.release();
    }
    return this.findOwned(partnerId, reservationId);
  }

  async cancel(partnerId: string, reservationId: string, reason: string): Promise<PartnerReservation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const row = await this.ownedReservation(client, partnerId, reservationId);
      if (!row) {
        await client.query("rollback");
        return null;
      }
      const previous = fromRow(row);
      if (previous.status === "cancelled") {
        await client.query("commit");
        return previous;
      }
      const details = normalizedDetails(row);
      const now = nowIso();
      details.status = "cancelled";
      details.cancellationReason = reason;
      details.updatedAt = now;
      details.history.push({ title: "Бронь отменена", details: reason, created: now });
      await client.query("delete from room_reservations where source_type = 'buffer' and source_id = $1::uuid", [reservationId]);
      await client.query("update room_reservations set active = false, details = $2::jsonb where id = $1::uuid", [reservationId, JSON.stringify(details)]);
      await this.audit(client, partnerId, "reservation_cancel", reservationId, previous, details);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findOwned(partnerId, reservationId);
  }

  async restore(partnerId: string, reservationId: string): Promise<PartnerReservation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const row = await this.ownedReservation(client, partnerId, reservationId);
      if (!row) {
        await client.query("rollback");
        return null;
      }
      const previous = fromRow(row);
      if (previous.status === "active") {
        await client.query("commit");
        return previous;
      }
      const room = await this.ownedRoom(client, partnerId, previous.roomId);
      if (!room) throw new ReservationActionError(404, "PARTNER_ROOM_NOT_FOUND", "Помещение больше не доступно площадке.");
      const details = normalizedDetails(row);
      const now = nowIso();
      details.status = "active";
      details.cancellationReason = null;
      details.updatedAt = now;
      details.history.push({ title: "Бронь восстановлена", details: "Интервал снова занимает календарь", created: now });
      await client.query("update room_reservations set active = true, details = $2::jsonb where id = $1::uuid", [reservationId, JSON.stringify(details)]);
      await this.insertBuffers(client, reservationId, room, previous.startsAt, previous.endsAt, partnerId);
      await this.audit(client, partnerId, "reservation_restore", reservationId, previous, details);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      this.rethrowConflict(error);
    } finally {
      client.release();
    }
    return this.findOwned(partnerId, reservationId);
  }

  async deleteTechnical(partnerId: string, reservationId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const row = await this.ownedReservation(client, partnerId, reservationId);
      if (!row) {
        await client.query("rollback");
        return false;
      }
      const previous = fromRow(row);
      if (previous.type === "manual_booking") throw new ReservationActionError(409, "RESERVATION_CANCEL_REQUIRED", "Ручную бронь нужно отменить с указанием причины.");
      await client.query("delete from room_reservations where id = $1::uuid or source_id = $1::uuid", [reservationId]);
      await this.audit(client, partnerId, "reservation_delete", reservationId, previous, null);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async blocksByDate(roomIds: string[], date: string): Promise<Record<string, HourInterval[]>> {
    if (!roomIds.length) return {};
    const result = await this.pool.query<ReservationRow>(`/* rooms:partner-reservation-blocks */
      select reservation.id::text, room.venue_id::text, room.id::text as room_id,
        room.slug as room_slug, room.title as room_title, reservation.source_type,
        lower(reservation.period) as starts_at, upper(reservation.period) as ends_at,
        reservation.active, reservation.details, room.buffer_minutes, reservation.created_at
      from room_reservations reservation
      join rooms room on room.id = reservation.room_id
      where room.id = any($1::uuid[])
        and reservation.source_type in ('manual_booking','technical')
        and reservation.active
        and reservation.period && tstzrange(
          $2::date::timestamp at time zone 'Europe/Moscow',
          ($2::date + 2)::timestamp at time zone 'Europe/Moscow','[)'
        )
    `, [roomIds, date]);
    const blocks: Record<string, HourInterval[]> = {};
    for (const row of result.rows) {
      const intervals = recordBlocks(fromRow(row), date);
      if (intervals.length) blocks[row.room_id] = [...(blocks[row.room_id] ?? []), ...intervals];
    }
    return blocks;
  }

  private async ownedRoom(client: PoolClient, partnerId: string, roomId: string): Promise<OwnedRoomRow | null> {
    const result = await client.query<OwnedRoomRow>(`
      select room.id::text, room.venue_id::text, room.slug, room.title, room.buffer_minutes
      from rooms room
      join venue_members member on member.venue_id = room.venue_id and member.user_id = $1::uuid
      where room.id = $2::uuid
      for update of room
    `, [partnerId, roomId]);
    return result.rows[0] ?? null;
  }

  private async ownedReservation(client: PoolClient, partnerId: string, reservationId: string): Promise<ReservationRow | null> {
    const result = await client.query<ReservationRow>(`
      select reservation.id::text, room.venue_id::text, room.id::text as room_id,
        room.slug as room_slug, room.title as room_title, reservation.source_type,
        lower(reservation.period) as starts_at, upper(reservation.period) as ends_at,
        reservation.active, reservation.details, room.buffer_minutes, reservation.created_at
      from room_reservations reservation
      join rooms room on room.id = reservation.room_id
      join venue_members member on member.venue_id = room.venue_id and member.user_id = $1::uuid
      where reservation.id = $2::uuid and reservation.source_type in ('manual_booking','technical')
      for update of reservation
    `, [partnerId, reservationId]);
    return result.rows[0] ?? null;
  }

  private async findOwned(partnerId: string, reservationId: string): Promise<PartnerReservation | null> {
    const result = await this.pool.query<ReservationRow>(`
      select reservation.id::text, room.venue_id::text, room.id::text as room_id,
        room.slug as room_slug, room.title as room_title, reservation.source_type,
        lower(reservation.period) as starts_at, upper(reservation.period) as ends_at,
        reservation.active, reservation.details, room.buffer_minutes, reservation.created_at
      from room_reservations reservation
      join rooms room on room.id = reservation.room_id
      join venue_members member on member.venue_id = room.venue_id and member.user_id = $1::uuid
      where reservation.id = $2::uuid and reservation.source_type in ('manual_booking','technical')
    `, [partnerId, reservationId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  private async insertBuffers(client: PoolClient, reservationId: string, room: OwnedRoomRow, startsAt: string, endsAt: string, partnerId: string): Promise<void> {
    if (Number(room.buffer_minutes) <= 0) return;
    const details = JSON.stringify({ parentReservationId: reservationId, minutes: Number(room.buffer_minutes) });
    await client.query(`
      insert into room_reservations (room_id, source_type, source_id, period, active, details, created_by)
      values ($1::uuid,'buffer',$2::uuid,tstzrange($3::timestamptz - make_interval(mins => $5),$3::timestamptz,'[)'),true,$6::jsonb,$4::uuid)
    `, [room.id, reservationId, startsAt, partnerId, Number(room.buffer_minutes), details]);
    await client.query(`
      insert into room_reservations (room_id, source_type, source_id, period, active, details, created_by)
      values ($1::uuid,'buffer',$2::uuid,tstzrange($3::timestamptz,$3::timestamptz + make_interval(mins => $5),'[)'),true,$6::jsonb,$4::uuid)
    `, [room.id, reservationId, endsAt, partnerId, Number(room.buffer_minutes), details]);
  }

  private async audit(client: PoolClient, partnerId: string, action: string, reservationId: string, before: unknown, after: unknown): Promise<void> {
    await client.query(`
      insert into audit_log (actor_id, actor_role, action, entity_type, entity_id, before_data, after_data)
      values ($1::uuid,'partner',$2,'room_reservation',$3,$4::jsonb,$5::jsonb)
    `, [partnerId, action, reservationId, JSON.stringify(before), JSON.stringify(after)]);
  }

  private rethrowConflict(error: unknown): never {
    if ((error as { code?: string }).code === "23P01") {
      throw new ReservationActionError(409, "SLOT_CONFLICT", "Интервал пересекается с другой бронью или технической занятостью.");
    }
    throw error;
  }
}
