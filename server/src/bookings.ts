import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { LegalAcceptance } from "./auth.js";
import type { PaymentMethod, PublicationStatus } from "./types.js";

export type BookingStatus = "pending" | "proposed" | "awaiting_payment" | "paid" | "expired" | "cancelled" | "visited" | "completed";
export type BookingStatusGroup = "active" | "completed" | "cancelled" | "all";
export type PartnerBookingStatusGroup = "new" | "payment" | "booked" | "history" | "all";

export interface BookingVenue {
  id: string;
  slug: string;
  title: string;
  city: string;
  address: string;
  paymentMethods: PaymentMethod[];
  publicationStatus: PublicationStatus;
  partnerMode: "catalog" | "crm";
}

export interface BookingRoom {
  id: string;
  slug: string;
  title: string;
  type: string;
  capacityMax: number;
  pricePerHour: number;
  amount: number;
  isPrimary: boolean;
  bufferMinutes: number;
}

export interface BookingService {
  id: string;
  name: string;
  description: string | null;
  price: number;
  quantity: number;
  amount: number;
}

export interface BookingMoney {
  roomTotal: number;
  serviceTotal: number;
  total: number;
  prepayment: number;
  remainingOnSite: number;
  currency: "RUB";
}

export interface BookingRecord {
  id: string;
  publicNumber: string;
  status: BookingStatus;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  venue: BookingVenue;
  rooms: BookingRoom[];
  services: BookingService[];
  startsAt: string;
  endsAt: string;
  guests: number;
  eventType: string | null;
  eventName: string | null;
  onSitePaymentMethod: PaymentMethod;
  comment: string;
  cancellationReason: string | null;
  cancelledBy: string | null;
  money: BookingMoney;
  paymentHoldExpiresAt: string | null;
  createdAt: string;
}

export interface BookingCreateInput {
  clientId: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  venue: BookingVenue;
  rooms: BookingRoom[];
  services: BookingService[];
  startsAt: string;
  endsAt: string;
  guests: number;
  eventType: string | null;
  eventName: string | null;
  onSitePaymentMethod: PaymentMethod;
  comment: string;
  money: BookingMoney;
  commission: number;
  partnerAmount: number;
  legal: LegalAcceptance;
  ip: string | null;
  userAgent: string | null;
}

export interface BookingRepository {
  readonly storage: "memory" | "postgresql";
  create(input: BookingCreateInput): Promise<BookingRecord>;
  listByClient(clientId: string, group: BookingStatusGroup): Promise<BookingRecord[]>;
  getPartnerVenue(partnerId: string): Promise<BookingVenue | null>;
  listByPartner(partnerId: string, group: PartnerBookingStatusGroup): Promise<BookingRecord[]>;
  confirmByPartner(partnerId: string, bookingId: string): Promise<BookingRecord | null>;
  rejectByPartner(partnerId: string, bookingId: string, reason: string): Promise<BookingRecord | null>;
}

export class BookingActionError extends Error {
  readonly statusCode = 409;

  constructor(readonly code: "SLOT_CONFLICT" | "BOOKING_STATE_CHANGED", message: string) {
    super(message);
  }
}

function statusInGroup(status: BookingStatus, group: BookingStatusGroup): boolean {
  if (group === "all") return true;
  if (group === "active") return ["pending", "proposed", "awaiting_payment", "paid"].includes(status);
  if (group === "completed") return ["visited", "completed"].includes(status);
  return ["cancelled", "expired"].includes(status);
}

function statusInPartnerGroup(status: BookingStatus, group: PartnerBookingStatusGroup): boolean {
  if (group === "all") return true;
  if (group === "new") return ["pending", "proposed"].includes(status);
  if (group === "payment") return status === "awaiting_payment";
  if (group === "booked") return status === "paid";
  return ["expired", "cancelled", "visited", "completed"].includes(status);
}

function partnerView(record: BookingRecord): BookingRecord {
  const contactVisible = ["paid", "visited", "completed"].includes(record.status);
  return {
    ...structuredClone(record),
    clientPhone: contactVisible ? record.clientPhone : null,
    clientEmail: contactVisible ? record.clientEmail : null,
  };
}

function publicNumber(id: string, createdAt: string): string {
  return `R-${createdAt.slice(0, 10).replaceAll("-", "")}-${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function newRecord(input: BookingCreateInput): BookingRecord {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  return {
    id,
    publicNumber: publicNumber(id, createdAt),
    status: "pending",
    clientId: input.clientId,
    clientName: input.clientName,
    clientPhone: input.clientPhone,
    clientEmail: input.clientEmail,
    venue: structuredClone(input.venue),
    rooms: structuredClone(input.rooms),
    services: structuredClone(input.services),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    guests: input.guests,
    eventType: input.eventType,
    eventName: input.eventName,
    onSitePaymentMethod: input.onSitePaymentMethod,
    comment: input.comment,
    cancellationReason: null,
    cancelledBy: null,
    money: structuredClone(input.money),
    paymentHoldExpiresAt: null,
    createdAt,
  };
}

interface MemoryPartnerAccess {
  userId: string;
  venue: BookingVenue;
}

interface MemoryBookingRepositoryOptions {
  partners?: MemoryPartnerAccess[];
  now?: () => Date;
}

interface MemoryReservation {
  bookingId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  expiresAt: number;
  active: boolean;
}

export class MemoryBookingRepository implements BookingRepository {
  readonly storage = "memory" as const;
  private readonly bookings: BookingRecord[] = [];
  private readonly reservations: MemoryReservation[] = [];
  private readonly partnerVenues = new Map<string, BookingVenue>();
  private readonly now: () => Date;

  constructor(options: MemoryBookingRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    for (const access of options.partners ?? []) this.partnerVenues.set(access.userId, structuredClone(access.venue));
  }

  async create(input: BookingCreateInput): Promise<BookingRecord> {
    const record = newRecord(input);
    this.bookings.unshift(record);
    return structuredClone(record);
  }

  async listByClient(clientId: string, group: BookingStatusGroup): Promise<BookingRecord[]> {
    this.releaseExpired();
    return structuredClone(this.bookings.filter((booking) => booking.clientId === clientId && statusInGroup(booking.status, group)));
  }

  async getPartnerVenue(partnerId: string): Promise<BookingVenue | null> {
    const venue = this.partnerVenues.get(partnerId);
    return venue ? structuredClone(venue) : null;
  }

  async listByPartner(partnerId: string, group: PartnerBookingStatusGroup): Promise<BookingRecord[]> {
    this.releaseExpired();
    const venue = this.partnerVenues.get(partnerId);
    if (!venue) return [];
    return this.bookings
      .filter((booking) => booking.venue.id === venue.id && statusInPartnerGroup(booking.status, group))
      .map(partnerView);
  }

  async confirmByPartner(partnerId: string, bookingId: string): Promise<BookingRecord | null> {
    this.releaseExpired();
    const booking = this.partnerBooking(partnerId, bookingId);
    if (!booking) return null;
    if (!["pending", "proposed"].includes(booking.status)) {
      throw new BookingActionError("BOOKING_STATE_CHANGED", "Заявка уже обработана. Обновите очередь.");
    }
    const startsAt = new Date(booking.startsAt).getTime();
    const endsAt = new Date(booking.endsAt).getTime();
    for (const room of booking.rooms) {
      const buffer = room.bufferMinutes * 60_000;
      const conflict = this.reservations.some((reservation) => (
        reservation.active && reservation.roomId === room.id && reservation.bookingId !== booking.id
        && startsAt - buffer < reservation.endsAt && endsAt + buffer > reservation.startsAt
      ));
      if (conflict) throw new BookingActionError("SLOT_CONFLICT", "Одно из помещений уже занято. Обновите очередь и предложите другое время.");
    }
    const expiresAt = this.now().getTime() + 15 * 60_000;
    booking.status = "awaiting_payment";
    booking.paymentHoldExpiresAt = new Date(expiresAt).toISOString();
    for (const room of booking.rooms) {
      const buffer = room.bufferMinutes * 60_000;
      this.reservations.push({ bookingId, roomId: room.id, startsAt: startsAt - buffer, endsAt: endsAt + buffer, expiresAt, active: true });
    }
    return partnerView(booking);
  }

  async rejectByPartner(partnerId: string, bookingId: string, _reason: string): Promise<BookingRecord | null> {
    this.releaseExpired();
    const booking = this.partnerBooking(partnerId, bookingId);
    if (!booking) return null;
    if (!["pending", "proposed", "awaiting_payment"].includes(booking.status)) {
      throw new BookingActionError("BOOKING_STATE_CHANGED", "Эту бронь уже нельзя отклонить из очереди.");
    }
    booking.status = "cancelled";
    booking.paymentHoldExpiresAt = null;
    booking.cancellationReason = _reason;
    booking.cancelledBy = "partner";
    for (const reservation of this.reservations) if (reservation.bookingId === bookingId) reservation.active = false;
    return partnerView(booking);
  }

  paymentBooking(clientId: string, bookingId: string): BookingRecord | null {
    this.releaseExpired();
    const booking = this.bookings.find((item) => item.id === bookingId && item.clientId === clientId);
    return booking ? structuredClone(booking) : null;
  }

  completePayment(clientId: string, bookingId: string): BookingRecord | null {
    this.releaseExpired();
    const booking = this.bookings.find((item) => item.id === bookingId && item.clientId === clientId);
    if (!booking) return null;
    if (booking.status === "paid") return structuredClone(booking);
    if (booking.status !== "awaiting_payment") return structuredClone(booking);
    booking.status = "paid";
    booking.paymentHoldExpiresAt = null;
    return structuredClone(booking);
  }

  hasReservationConflict(roomId: string, startsAt: number, endsAt: number, excludeOwnerId = ""): boolean {
    this.releaseExpired();
    return this.reservations.some((reservation) => (
      reservation.active
      && reservation.roomId === roomId
      && reservation.bookingId !== excludeOwnerId
      && startsAt < reservation.endsAt
      && endsAt > reservation.startsAt
    ));
  }

  setExternalReservation(ownerId: string, roomId: string, startsAt: number, endsAt: number): void {
    this.removeExternalReservation(ownerId);
    this.reservations.push({ bookingId: ownerId, roomId, startsAt, endsAt, expiresAt: Number.POSITIVE_INFINITY, active: true });
  }

  removeExternalReservation(ownerId: string): void {
    for (const reservation of this.reservations) if (reservation.bookingId === ownerId) reservation.active = false;
  }

  private partnerBooking(partnerId: string, bookingId: string): BookingRecord | null {
    const venue = this.partnerVenues.get(partnerId);
    return venue ? this.bookings.find((booking) => booking.id === bookingId && booking.venue.id === venue.id) ?? null : null;
  }

  private releaseExpired(): void {
    const now = this.now().getTime();
    for (const booking of this.bookings) {
      if (booking.status !== "awaiting_payment" || !booking.paymentHoldExpiresAt || new Date(booking.paymentHoldExpiresAt).getTime() > now) continue;
      booking.status = "expired";
      booking.paymentHoldExpiresAt = null;
      for (const reservation of this.reservations) if (reservation.bookingId === booking.id) reservation.active = false;
    }
  }
}

interface BookingRow extends QueryResultRow {
  id: string;
  public_number: string;
  status: BookingStatus;
  client_id: string;
  client_name: string;
  client_phone: string;
  client_email: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  guests: number;
  event_type: string | null;
  event_name: string | null;
  on_site_payment_method: PaymentMethod | null;
  comment: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  room_total: string | number;
  service_total: string | number;
  total: string | number;
  prepayment: string | number;
  remaining_on_site: string | number;
  payment_hold_expires_at: Date | string | null;
  created_at: Date | string;
  venue_id: string;
  venue_slug: string;
  venue_title: string;
  city: string;
  venue_address: string;
  payment_methods: PaymentMethod[];
  publication_status: PublicationStatus;
  partner_mode: "catalog" | "crm";
}

interface BookingRoomRow extends QueryResultRow {
  booking_id: string;
  room_id: string;
  slug: string | null;
  title_snapshot: string;
  room_type: string | null;
  capacity_max: number | null;
  price_per_hour_snapshot: string | number;
  amount: string | number;
  is_primary: boolean;
  buffer_minutes: number | null;
}

interface PartnerVenueRow extends QueryResultRow {
  id: string;
  slug: string;
  title: string;
  city: string;
  address: string;
  payment_methods: PaymentMethod[];
  publication_status: PublicationStatus;
  partner_mode: "catalog" | "crm";
}

interface PartnerActionBookingRow extends QueryResultRow {
  id: string;
  status: BookingStatus;
  starts_at: Date | string;
  ends_at: Date | string;
}

interface PartnerActionRoomRow extends QueryResultRow {
  room_id: string;
  buffer_minutes: number;
}

interface BookingServiceRow extends QueryResultRow {
  booking_id: string;
  service_id: string;
  name_snapshot: string;
  description_snapshot: string | null;
  unit_price: string | number;
  quantity: number;
  amount: string | number;
}

function number(value: string | number): number {
  return Number(value) || 0;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export class PostgresBookingRepository implements BookingRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly pool: Pool) {}

  async create(input: BookingCreateInput): Promise<BookingRecord> {
    const record = newRecord(input);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`/* rooms:create-booking */
        insert into bookings (
          id, public_number, client_id, venue_id, status, client_name, client_phone, client_email,
          city, event_type, event_name, guests, starts_at, ends_at, room_total, service_total,
          total, prepayment, commission, partner_amount, remaining_on_site,
          on_site_payment_method, comment, created_at, updated_at
        ) values (
          $1::uuid,$2,$3::uuid,$4::uuid,'pending',$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,
          $14,$15,$16,$17,$18,$19,$20,$21,$22,$23::timestamptz,$23::timestamptz
        )
      `, [
        record.id, record.publicNumber, input.clientId, input.venue.id, input.clientName, input.clientPhone,
        input.clientEmail, input.venue.city, input.eventType, input.eventName, input.guests, input.startsAt,
        input.endsAt, input.money.roomTotal, input.money.serviceTotal, input.money.total, input.money.prepayment,
        input.commission, input.partnerAmount, input.money.remainingOnSite, input.onSitePaymentMethod,
        input.comment || null, record.createdAt,
      ]);
      for (const room of input.rooms) await this.insertRoom(client, record.id, room);
      for (const service of input.services) await this.insertService(client, record.id, service);
      await this.insertConsent(client, record.id, input);
      await client.query("commit");
      return record;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listByClient(clientId: string, group: BookingStatusGroup): Promise<BookingRecord[]> {
    await this.releaseExpired(this.pool);
    const result = await this.pool.query<BookingRow>(`/* rooms:list-client-bookings */
      select b.id::text, b.public_number, b.status, b.client_id::text, b.client_name,
        b.client_phone, b.client_email::text, b.starts_at, b.ends_at, b.guests,
        b.event_type, b.event_name, b.on_site_payment_method, b.comment, b.cancellation_reason, b.cancelled_by,
        b.room_total, b.service_total, b.total, b.prepayment, b.remaining_on_site,
        b.payment_hold_expires_at, b.created_at,
        v.id::text as venue_id, v.slug as venue_slug, v.title as venue_title,
        b.city, v.address as venue_address, v.payment_methods,
        v.publication_status, v.partner_mode
      from bookings b
      join venues v on v.id = b.venue_id
      where b.client_id = $1::uuid
      order by b.created_at desc
      limit 100
    `, [clientId]);
    const filtered = result.rows.filter((row) => statusInGroup(row.status, group));
    return this.hydrate(filtered);
  }

  async getPartnerVenue(partnerId: string): Promise<BookingVenue | null> {
    const result = await this.pool.query<PartnerVenueRow>(`/* rooms:partner-venue */
      select v.id::text, v.slug, v.title, v.city, v.address, v.payment_methods,
        v.publication_status, v.partner_mode
      from venue_members member
      join venues v on v.id = member.venue_id
      where member.user_id = $1::uuid
      order by member.created_at
      limit 1
    `, [partnerId]);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      slug: row.slug,
      title: row.title,
      city: row.city,
      address: row.address,
      paymentMethods: row.payment_methods,
      publicationStatus: row.publication_status,
      partnerMode: row.partner_mode,
    } : null;
  }

  async listByPartner(partnerId: string, group: PartnerBookingStatusGroup): Promise<BookingRecord[]> {
    await this.releaseExpired(this.pool);
    const rows = await this.partnerRows(partnerId, null);
    const filtered = rows.filter((row) => statusInPartnerGroup(row.status, group));
    return (await this.hydrate(filtered)).map(partnerView);
  }

  async confirmByPartner(partnerId: string, bookingId: string): Promise<BookingRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.releaseExpired(client);
      const bookingResult = await client.query<PartnerActionBookingRow>(`/* rooms:lock-partner-booking */
        select b.id::text, b.status, b.starts_at, b.ends_at
        from bookings b
        join venue_members member on member.venue_id = b.venue_id and member.user_id = $1::uuid
        where b.id = $2::uuid
        for update of b
      `, [partnerId, bookingId]);
      const booking = bookingResult.rows[0];
      if (!booking) {
        await client.query("rollback");
        return null;
      }
      if (!["pending", "proposed"].includes(booking.status)) {
        throw new BookingActionError("BOOKING_STATE_CHANGED", "Заявка уже обработана. Обновите очередь.");
      }
      const roomResult = await client.query<PartnerActionRoomRow>(`/* rooms:lock-booking-rooms */
        select room.id::text as room_id, room.buffer_minutes
        from booking_rooms booking_room
        join rooms room on room.id = booking_room.room_id
        where booking_room.booking_id = $1::uuid
        order by room.id
        for update of room
      `, [bookingId]);
      if (!roomResult.rows.length) throw new BookingActionError("BOOKING_STATE_CHANGED", "В заявке не осталось доступных помещений.");
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await client.query(`
        update room_reservations set active = false
        where booking_id = $1::uuid and active
      `, [bookingId]);
      for (const room of roomResult.rows) {
        await this.insertPaymentHold(client, partnerId, bookingId, room, booking.starts_at, booking.ends_at, expiresAt);
      }
      await client.query(`
        update bookings set status = 'awaiting_payment', payment_hold_expires_at = $2::timestamptz, updated_at = now()
        where id = $1::uuid
      `, [bookingId, expiresAt]);
      await client.query(`
        insert into booking_status_history (booking_id, from_status, to_status, actor_id, actor_role, title, details)
        values ($1::uuid,$2::booking_status,'awaiting_payment',$3::uuid,'partner','Площадка подтвердила заявку','Слот удерживается 15 минут до предоплаты')
      `, [bookingId, booking.status, partnerId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23P01") {
        throw new BookingActionError("SLOT_CONFLICT", "Одно из помещений уже занято. Обновите очередь и предложите другое время.");
      }
      throw error;
    } finally {
      client.release();
    }
    return this.findPartnerBooking(partnerId, bookingId);
  }

  async rejectByPartner(partnerId: string, bookingId: string, reason: string): Promise<BookingRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.releaseExpired(client);
      const bookingResult = await client.query<PartnerActionBookingRow>(`/* rooms:lock-partner-booking-for-reject */
        select b.id::text, b.status, b.starts_at, b.ends_at
        from bookings b
        join venue_members member on member.venue_id = b.venue_id and member.user_id = $1::uuid
        where b.id = $2::uuid
        for update of b
      `, [partnerId, bookingId]);
      const booking = bookingResult.rows[0];
      if (!booking) {
        await client.query("rollback");
        return null;
      }
      if (!["pending", "proposed", "awaiting_payment"].includes(booking.status)) {
        throw new BookingActionError("BOOKING_STATE_CHANGED", "Эту бронь уже нельзя отклонить из очереди.");
      }
      await client.query(`
        update room_reservations set active = false
        where booking_id = $1::uuid and active
      `, [bookingId]);
      await client.query(`
        update bookings set status = 'cancelled', payment_hold_expires_at = null,
          cancellation_reason = $2, cancelled_by = 'partner', updated_at = now()
        where id = $1::uuid
      `, [bookingId, reason]);
      await client.query(`
        insert into booking_status_history (booking_id, from_status, to_status, actor_id, actor_role, title, details)
        values ($1::uuid,$2::booking_status,'cancelled',$3::uuid,'partner','Площадка отклонила заявку',$4)
      `, [bookingId, booking.status, partnerId, reason]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findPartnerBooking(partnerId, bookingId);
  }

  private async partnerRows(partnerId: string, bookingId: string | null): Promise<BookingRow[]> {
    const result = await this.pool.query<BookingRow>(`/* rooms:list-partner-bookings */
      select b.id::text, b.public_number, b.status, b.client_id::text, b.client_name,
        b.client_phone, b.client_email::text, b.starts_at, b.ends_at, b.guests,
        b.event_type, b.event_name, b.on_site_payment_method, b.comment, b.cancellation_reason, b.cancelled_by,
        b.room_total, b.service_total, b.total, b.prepayment, b.remaining_on_site,
        b.payment_hold_expires_at, b.created_at,
        v.id::text as venue_id, v.slug as venue_slug, v.title as venue_title,
        b.city, v.address as venue_address, v.payment_methods,
        v.publication_status, v.partner_mode
      from bookings b
      join venues v on v.id = b.venue_id
      join venue_members member on member.venue_id = b.venue_id and member.user_id = $1::uuid
      where ($2::uuid is null or b.id = $2::uuid)
      order by b.created_at desc
      limit 100
    `, [partnerId, bookingId]);
    return result.rows;
  }

  private async findPartnerBooking(partnerId: string, bookingId: string): Promise<BookingRecord | null> {
    const rows = await this.partnerRows(partnerId, bookingId);
    const records = await this.hydrate(rows);
    return records[0] ? partnerView(records[0]) : null;
  }

  private async hydrate(rows: BookingRow[]): Promise<BookingRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [roomResult, serviceResult] = await Promise.all([
      this.pool.query<BookingRoomRow>(`/* rooms:booking-rooms */
        select br.booking_id::text, br.room_id::text, r.slug, br.title_snapshot,
          r.room_type, r.capacity_max, br.price_per_hour_snapshot, br.amount, br.is_primary,
          coalesce(r.buffer_minutes, 0) as buffer_minutes
        from booking_rooms br
        left join rooms r on r.id = br.room_id
        where br.booking_id = any($1::uuid[])
        order by br.booking_id, br.is_primary desc, br.title_snapshot
      `, [ids]),
      this.pool.query<BookingServiceRow>(`/* rooms:booking-services */
        select bs.booking_id::text, coalesce(bs.room_service_id, bs.id)::text as service_id,
          bs.name_snapshot, bs.description_snapshot, bs.unit_price, bs.quantity, bs.amount
        from booking_services bs
        where bs.booking_id = any($1::uuid[])
        order by bs.booking_id, bs.name_snapshot
      `, [ids]),
    ]);
    const rooms = new Map<string, BookingRoom[]>();
    for (const row of roomResult.rows) {
      const items = rooms.get(row.booking_id) ?? [];
      items.push({
        id: row.room_id,
        slug: row.slug ?? row.room_id,
        title: row.title_snapshot,
        type: row.room_type ?? "room",
        capacityMax: Number(row.capacity_max) || 1,
        pricePerHour: number(row.price_per_hour_snapshot),
        amount: number(row.amount),
        isPrimary: row.is_primary,
        bufferMinutes: Number(row.buffer_minutes) || 0,
      });
      rooms.set(row.booking_id, items);
    }
    const services = new Map<string, BookingService[]>();
    for (const row of serviceResult.rows) {
      const items = services.get(row.booking_id) ?? [];
      items.push({
        id: row.service_id,
        name: row.name_snapshot,
        description: row.description_snapshot,
        price: number(row.unit_price),
        quantity: row.quantity,
        amount: number(row.amount),
      });
      services.set(row.booking_id, items);
    }
    return rows.map((row) => ({
      id: row.id,
      publicNumber: row.public_number,
      status: row.status,
      clientId: row.client_id,
      clientName: row.client_name,
      clientPhone: row.client_phone,
      clientEmail: row.client_email,
      venue: {
        id: row.venue_id,
        slug: row.venue_slug,
        title: row.venue_title,
        city: row.city,
        address: row.venue_address,
        paymentMethods: row.payment_methods,
        publicationStatus: row.publication_status,
        partnerMode: row.partner_mode,
      },
      rooms: rooms.get(row.id) ?? [],
      services: services.get(row.id) ?? [],
      startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at),
      guests: row.guests,
      eventType: row.event_type,
      eventName: row.event_name,
      onSitePaymentMethod: row.on_site_payment_method ?? "card",
      comment: row.comment ?? "",
      cancellationReason: row.cancellation_reason,
      cancelledBy: row.cancelled_by,
      money: {
        roomTotal: number(row.room_total),
        serviceTotal: number(row.service_total),
        total: number(row.total),
        prepayment: number(row.prepayment),
        remainingOnSite: number(row.remaining_on_site),
        currency: "RUB",
      },
      paymentHoldExpiresAt: row.payment_hold_expires_at === null ? null : iso(row.payment_hold_expires_at),
      createdAt: iso(row.created_at),
    }));
  }

  private async insertPaymentHold(
    client: PoolClient,
    partnerId: string,
    bookingId: string,
    room: PartnerActionRoomRow,
    startsAt: Date | string,
    endsAt: Date | string,
    expiresAt: string,
  ): Promise<void> {
    await client.query(`
      insert into room_reservations (
        room_id, booking_id, source_type, source_id, period, active, expires_at, details, created_by
      ) values (
        $1::uuid,$2::uuid,'payment_hold',$2::uuid,tstzrange($3::timestamptz,$4::timestamptz,'[)'),true,
        $5::timestamptz,jsonb_build_object('reason','partner_confirmation'),$6::uuid
      )
    `, [room.room_id, bookingId, startsAt, endsAt, expiresAt, partnerId]);
    if (room.buffer_minutes <= 0) return;
    await client.query(`
      insert into room_reservations (
        room_id, booking_id, source_type, source_id, period, active, expires_at, details, created_by
      ) values (
        $1::uuid,$2::uuid,'buffer',$2::uuid,
        tstzrange($3::timestamptz - make_interval(mins => $6),$3::timestamptz,'[)'),true,
        $5::timestamptz,jsonb_build_object('position','before','minutes',$6),$7::uuid
      )
    `, [room.room_id, bookingId, startsAt, endsAt, expiresAt, room.buffer_minutes, partnerId]);
    await client.query(`
      insert into room_reservations (
        room_id, booking_id, source_type, source_id, period, active, expires_at, details, created_by
      ) values (
        $1::uuid,$2::uuid,'buffer',$2::uuid,
        tstzrange($4::timestamptz,$4::timestamptz + make_interval(mins => $6),'[)'),true,
        $5::timestamptz,jsonb_build_object('position','after','minutes',$6),$7::uuid
      )
    `, [room.room_id, bookingId, startsAt, endsAt, expiresAt, room.buffer_minutes, partnerId]);
  }

  private async releaseExpired(connection: Pool | PoolClient): Promise<void> {
    await connection.query(`/* rooms:expire-payment-holds */
      with expired as (
        update bookings
        set status = 'expired', payment_hold_expires_at = null, updated_at = now()
        where status = 'awaiting_payment'
          and payment_hold_expires_at is not null
          and payment_hold_expires_at <= now()
        returning id
      ), released as (
        update room_reservations reservation set active = false
        from expired
        where reservation.booking_id = expired.id and reservation.active
        returning reservation.id
      )
      insert into booking_status_history (booking_id, from_status, to_status, actor_role, title, details)
      select id, 'awaiting_payment', 'expired', 'admin', 'Время предоплаты истекло',
        'Слот автоматически освобождён через 15 минут'
      from expired
    `);
  }

  private async insertRoom(client: PoolClient, bookingId: string, room: BookingRoom): Promise<void> {
    await client.query(`
      insert into booking_rooms (booking_id, room_id, title_snapshot, price_per_hour_snapshot, amount, is_primary)
      values ($1::uuid,$2::uuid,$3,$4,$5,$6)
    `, [bookingId, room.id, room.title, room.pricePerHour, room.amount, room.isPrimary]);
  }

  private async insertService(client: PoolClient, bookingId: string, service: BookingService): Promise<void> {
    await client.query(`
      insert into booking_services (
        booking_id, room_service_id, name_snapshot, description_snapshot, unit_price, quantity, amount
      ) values ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)
    `, [bookingId, service.id, service.name, service.description, service.price, service.quantity, service.amount]);
  }

  private async insertConsent(client: PoolClient, bookingId: string, input: BookingCreateInput): Promise<void> {
    const version = input.legal.termsVersion === input.legal.privacyVersion
      ? input.legal.termsVersion
      : `terms:${input.legal.termsVersion};privacy:${input.legal.privacyVersion}`;
    await client.query(`
      insert into personal_data_consents (
        user_id, booking_id, subject_phone, subject_email, context, documents,
        document_version, ip, user_agent, accepted_at
      ) values ($1::uuid,$2::uuid,$3,$4,'booking',array['terms','privacy'],$5,$6::inet,$7,$8::timestamptz)
    `, [input.clientId, bookingId, input.clientPhone, input.clientEmail, version, input.ip, input.userAgent, input.legal.acceptedAt]);
  }
}
