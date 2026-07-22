import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { BookingRecord, BookingRepository } from "./bookings.js";

export type SupportStatus = "open" | "working" | "closed";
export type SupportQueryStatus = SupportStatus | "all";
export type SupportActorRole = "client" | "partner" | "admin";

export interface SupportMessageRecord {
  id: string;
  senderId: string | null;
  senderRole: SupportActorRole;
  body: string;
  createdAt: string;
}

export interface SupportCaseRecord {
  id: string;
  bookingId: string;
  publicNumber: string;
  venueTitle: string;
  roomTitle: string;
  startsAt: string;
  topic: string;
  status: SupportStatus;
  openedBy: string | null;
  openedByRole: SupportActorRole;
  assignedTo: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: SupportMessageRecord[];
}

export interface SupportRepository {
  readonly storage: "memory" | "postgresql";
  list(actorId: string, actorRole: SupportActorRole, status: SupportQueryStatus, limit: number): Promise<SupportCaseRecord[]>;
  listByBooking(actorId: string, actorRole: SupportActorRole, bookingId: string): Promise<SupportCaseRecord[] | null>;
  open(actorId: string, actorRole: SupportActorRole, bookingId: string, topic: string, body: string): Promise<SupportCaseRecord | null>;
  addMessage(actorId: string, actorRole: SupportActorRole, supportId: string, body: string): Promise<SupportCaseRecord | null>;
  setStatus(adminId: string, supportId: string, status: SupportStatus): Promise<SupportCaseRecord | null>;
}

export class SupportActionError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: "SUPPORT_CASE_CLOSED" | "SUPPORT_STATE_CHANGED",
    message: string,
  ) {
    super(message);
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function bookingSummary(booking: BookingRecord) {
  return {
    publicNumber: booking.publicNumber,
    venueTitle: booking.venue.title,
    roomTitle: booking.rooms.find((room) => room.isPrimary)?.title ?? booking.rooms[0]?.title ?? "Помещение",
    startsAt: booking.startsAt,
  };
}

export class MemorySupportRepository implements SupportRepository {
  readonly storage = "memory" as const;
  private readonly records: SupportCaseRecord[] = [];

  constructor(
    private readonly bookings: BookingRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(actorId: string, actorRole: SupportActorRole, status: SupportQueryStatus, limit: number): Promise<SupportCaseRecord[]> {
    const visible: SupportCaseRecord[] = [];
    for (const record of this.records) {
      if (status !== "all" && record.status !== status) continue;
      if (await this.bookingFor(actorId, actorRole, record.bookingId)) visible.push(structuredClone(record));
    }
    const rank: Record<SupportStatus, number> = { open: 0, working: 1, closed: 2 };
    return visible
      .sort((left, right) => rank[left.status] - rank[right.status] || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  async listByBooking(actorId: string, actorRole: SupportActorRole, bookingId: string): Promise<SupportCaseRecord[] | null> {
    if (!await this.bookingFor(actorId, actorRole, bookingId)) return null;
    return this.records
      .filter((record) => record.bookingId === bookingId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => structuredClone(record));
  }

  async open(actorId: string, actorRole: SupportActorRole, bookingId: string, topic: string, body: string): Promise<SupportCaseRecord | null> {
    const booking = await this.bookingFor(actorId, actorRole, bookingId);
    if (!booking) return null;
    const timestamp = this.now().toISOString();
    const current = this.records.find((record) => record.bookingId === bookingId && record.status !== "closed");
    if (current) {
      current.messages.push(this.message(actorId, actorRole, body, timestamp));
      current.updatedAt = timestamp;
      return structuredClone(current);
    }
    const record: SupportCaseRecord = {
      id: randomUUID(),
      bookingId,
      ...bookingSummary(booking),
      topic: topic.trim(),
      status: "open",
      openedBy: actorId,
      openedByRole: actorRole,
      assignedTo: null,
      closedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [this.message(actorId, actorRole, body, timestamp)],
    };
    this.records.unshift(record);
    return structuredClone(record);
  }

  async addMessage(actorId: string, actorRole: SupportActorRole, supportId: string, body: string): Promise<SupportCaseRecord | null> {
    const record = this.records.find((item) => item.id === supportId);
    if (!record || !await this.bookingFor(actorId, actorRole, record.bookingId)) return null;
    if (record.status === "closed") throw new SupportActionError("SUPPORT_CASE_CLOSED", "Обращение уже закрыто. Создайте новое, если вопрос остался.");
    const timestamp = this.now().toISOString();
    record.messages.push(this.message(actorId, actorRole, body, timestamp));
    record.updatedAt = timestamp;
    return structuredClone(record);
  }

  async setStatus(adminId: string, supportId: string, status: SupportStatus): Promise<SupportCaseRecord | null> {
    const record = this.records.find((item) => item.id === supportId);
    if (!record) return null;
    const timestamp = this.now().toISOString();
    record.status = status;
    record.assignedTo = status === "working" ? adminId : record.assignedTo;
    record.closedAt = status === "closed" ? timestamp : null;
    record.updatedAt = timestamp;
    return structuredClone(record);
  }

  private async bookingFor(actorId: string, actorRole: SupportActorRole, bookingId: string): Promise<BookingRecord | null> {
    if (actorRole === "client") return this.bookings.findByClient(actorId, bookingId);
    if (actorRole === "partner") return this.bookings.findByPartner(actorId, bookingId);
    return this.bookings.findByAdmin(bookingId);
  }

  private message(actorId: string, actorRole: SupportActorRole, body: string, createdAt: string): SupportMessageRecord {
    return { id: randomUUID(), senderId: actorId, senderRole: actorRole, body: body.trim(), createdAt };
  }
}

interface SupportCaseRow extends QueryResultRow {
  id: string;
  booking_id: string;
  public_number: string;
  venue_title: string;
  room_title: string;
  starts_at: Date | string;
  topic: string;
  status: SupportStatus;
  opened_by: string | null;
  opened_by_role: SupportActorRole;
  assigned_to: string | null;
  closed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SupportMessageRow extends QueryResultRow {
  id: string;
  support_case_id: string;
  sender_id: string | null;
  sender_role: SupportActorRole;
  body: string;
  created_at: Date | string;
}

interface SupportAccessRow extends QueryResultRow {
  id: string;
  status?: SupportStatus;
  assigned_to?: string | null;
}

const SUPPORT_SELECT = `
  select support_case.id::text, support_case.booking_id::text, booking.public_number,
    venue.title as venue_title,
    coalesce((
      select booking_room.title_snapshot from booking_rooms booking_room
      where booking_room.booking_id = booking.id
      order by booking_room.is_primary desc, booking_room.title_snapshot
      limit 1
    ), 'Помещение') as room_title,
    booking.starts_at, support_case.topic, support_case.status,
    support_case.opened_by::text, support_case.opened_by_role,
    support_case.assigned_to::text, support_case.closed_at,
    support_case.created_at, support_case.updated_at
  from booking_support_cases support_case
  join bookings booking on booking.id = support_case.booking_id
  join venues venue on venue.id = booking.venue_id
`;

function recordFromRow(row: SupportCaseRow, messages: SupportMessageRecord[]): SupportCaseRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    publicNumber: row.public_number,
    venueTitle: row.venue_title,
    roomTitle: row.room_title,
    startsAt: iso(row.starts_at)!,
    topic: row.topic,
    status: row.status,
    openedBy: row.opened_by,
    openedByRole: row.opened_by_role,
    assignedTo: row.assigned_to,
    closedAt: iso(row.closed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    messages,
  };
}

export class PostgresSupportRepository implements SupportRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly pool: Pool) {}

  async list(actorId: string, actorRole: SupportActorRole, status: SupportQueryStatus, limit: number): Promise<SupportCaseRecord[]> {
    const result = await this.pool.query<SupportCaseRow>(`${SUPPORT_SELECT}
      where ($3::text = 'all' or support_case.status = $3::text)
        and (
          $2::text = 'admin'
          or ($2::text = 'client' and booking.client_id = $1::uuid)
          or ($2::text = 'partner' and exists (
            select 1 from venue_members member
            where member.venue_id = booking.venue_id and member.user_id = $1::uuid
          ))
        )
      order by case support_case.status when 'open' then 0 when 'working' then 1 else 2 end,
        support_case.updated_at desc
      limit $4
    `, [actorId, actorRole, status, limit]);
    return this.hydrate(result.rows);
  }

  async listByBooking(actorId: string, actorRole: SupportActorRole, bookingId: string): Promise<SupportCaseRecord[] | null> {
    if (!await this.hasBookingAccess(this.pool, actorId, actorRole, bookingId)) return null;
    const result = await this.pool.query<SupportCaseRow>(`${SUPPORT_SELECT}
      where support_case.booking_id = $1::uuid
      order by support_case.updated_at desc
    `, [bookingId]);
    return this.hydrate(result.rows);
  }

  async open(actorId: string, actorRole: SupportActorRole, bookingId: string, topic: string, body: string): Promise<SupportCaseRecord | null> {
    const client = await this.pool.connect();
    let supportId = "";
    try {
      await client.query("begin");
      if (!await this.hasBookingAccess(client, actorId, actorRole, bookingId, true)) {
        await client.query("rollback");
        return null;
      }
      const current = await client.query<SupportAccessRow>(`
        select id::text, status from booking_support_cases
        where booking_id = $1::uuid and status <> 'closed'
        order by created_at desc limit 1 for update
      `, [bookingId]);
      supportId = current.rows[0]?.id ?? randomUUID();
      if (!current.rows[0]) {
        await client.query(`
          insert into booking_support_cases (
            id, booking_id, opened_by, opened_by_role, topic, status, created_at, updated_at
          ) values ($1::uuid,$2::uuid,$3::uuid,$4::user_role,$5,'open',now(),now())
        `, [supportId, bookingId, actorId, actorRole, topic.trim()]);
      }
      await client.query(`
        insert into booking_support_messages (support_case_id, sender_id, sender_role, body)
        values ($1::uuid,$2::uuid,$3::user_role,$4)
      `, [supportId, actorId, actorRole, body.trim()]);
      await client.query("update booking_support_cases set updated_at = now() where id = $1::uuid", [supportId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findAccessible(actorId, actorRole, supportId);
  }

  async addMessage(actorId: string, actorRole: SupportActorRole, supportId: string, body: string): Promise<SupportCaseRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const access = await client.query<SupportAccessRow>(`
        select support_case.id::text, support_case.status
        from booking_support_cases support_case
        join bookings booking on booking.id = support_case.booking_id
        where support_case.id = $3::uuid
          and (
            $2::text = 'admin'
            or ($2::text = 'client' and booking.client_id = $1::uuid)
            or ($2::text = 'partner' and exists (
              select 1 from venue_members member
              where member.venue_id = booking.venue_id and member.user_id = $1::uuid
            ))
          )
        for update of support_case
      `, [actorId, actorRole, supportId]);
      const record = access.rows[0];
      if (!record) {
        await client.query("rollback");
        return null;
      }
      if (record.status === "closed") throw new SupportActionError("SUPPORT_CASE_CLOSED", "Обращение уже закрыто. Создайте новое, если вопрос остался.");
      await client.query(`
        insert into booking_support_messages (support_case_id, sender_id, sender_role, body)
        values ($1::uuid,$2::uuid,$3::user_role,$4)
      `, [supportId, actorId, actorRole, body.trim()]);
      await client.query("update booking_support_cases set updated_at = now() where id = $1::uuid", [supportId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findAccessible(actorId, actorRole, supportId);
  }

  async setStatus(adminId: string, supportId: string, status: SupportStatus): Promise<SupportCaseRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const currentResult = await client.query<SupportAccessRow>(`/* rooms:lock-support-status */
        select id::text, status, assigned_to::text
        from booking_support_cases
        where id = $1::uuid
        for update
      `, [supportId]);
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("rollback");
        return null;
      }
      const nextAssignedTo = status === "working" ? adminId : current.assigned_to ?? null;
      if (current.status !== status || current.assigned_to !== nextAssignedTo) {
        await client.query(`/* rooms:update-support-status */
          update booking_support_cases
          set status = $2,
            assigned_to = $3::uuid,
            closed_at = case when $2 = 'closed' then now() else null end,
            updated_at = now()
          where id = $1::uuid
        `, [supportId, status, nextAssignedTo]);
        await client.query(`insert into audit_log (
          actor_id, actor_role, action, entity_type, entity_id, before_data, after_data
        ) values ($1::uuid,'admin','support_status_changed','support_case',$2,$3::jsonb,$4::jsonb)`, [
          adminId,
          supportId,
          JSON.stringify({ status: current.status, assignedTo: current.assigned_to ?? null }),
          JSON.stringify({ status, assignedTo: nextAssignedTo }),
        ]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") {
        throw new SupportActionError("SUPPORT_STATE_CHANGED", "По этой брони уже есть другое открытое обращение.");
      }
      throw error;
    } finally {
      client.release();
    }
    return this.findAccessible(adminId, "admin", supportId);
  }

  private async findAccessible(actorId: string, actorRole: SupportActorRole, supportId: string): Promise<SupportCaseRecord | null> {
    const result = await this.pool.query<SupportCaseRow>(`${SUPPORT_SELECT}
      where support_case.id = $3::uuid
        and (
          $2::text = 'admin'
          or ($2::text = 'client' and booking.client_id = $1::uuid)
          or ($2::text = 'partner' and exists (
            select 1 from venue_members member
            where member.venue_id = booking.venue_id and member.user_id = $1::uuid
          ))
        )
      limit 1
    `, [actorId, actorRole, supportId]);
    return (await this.hydrate(result.rows))[0] ?? null;
  }

  private async hasBookingAccess(
    connection: Pool | PoolClient,
    actorId: string,
    actorRole: SupportActorRole,
    bookingId: string,
    lock = false,
  ): Promise<boolean> {
    const result = await connection.query<SupportAccessRow>(`
      select booking.id::text
      from bookings booking
      where booking.id = $3::uuid
        and (
          $2::text = 'admin'
          or ($2::text = 'client' and booking.client_id = $1::uuid)
          or ($2::text = 'partner' and exists (
            select 1 from venue_members member
            where member.venue_id = booking.venue_id and member.user_id = $1::uuid
          ))
        )
      ${lock ? "for update of booking" : ""}
    `, [actorId, actorRole, bookingId]);
    return Boolean(result.rows[0]);
  }

  private async hydrate(rows: SupportCaseRow[]): Promise<SupportCaseRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const result = await this.pool.query<SupportMessageRow>(`
      select id::text, support_case_id::text, sender_id::text, sender_role, body, created_at
      from booking_support_messages
      where support_case_id = any($1::uuid[])
      order by created_at, id
    `, [ids]);
    const messages = new Map<string, SupportMessageRecord[]>();
    for (const row of result.rows) {
      const list = messages.get(row.support_case_id) ?? [];
      list.push({
        id: row.id,
        senderId: row.sender_id,
        senderRole: row.sender_role,
        body: row.body,
        createdAt: iso(row.created_at)!,
      });
      messages.set(row.support_case_id, list);
    }
    return rows.map((row) => recordFromRow(row, messages.get(row.id) ?? []));
  }
}
