import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { BookingRecord, BookingRepository } from "./bookings.js";
import type { CatalogRepository } from "./catalog.js";
import type { PublicReview } from "./types.js";

export type ReviewStatus = "pending" | "approved" | "rejected";
export type ReviewQueryStatus = ReviewStatus | "all";

export interface ReviewRecord {
  id: string;
  bookingId: string;
  roomId: string;
  roomSlug: string;
  roomTitle: string;
  venueId: string;
  venueTitle: string;
  clientId: string | null;
  authorName: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  partnerReply: string | null;
  moderationComment: string | null;
  moderatedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSubmitInput {
  roomId: string;
  rating: number;
  body: string;
}

export interface ReviewRepository {
  readonly storage: "memory" | "postgresql";
  listPublicRoom(idOrSlug: string): Promise<PublicReview[] | null>;
  listByClient(clientId: string): Promise<ReviewRecord[]>;
  listByPartner(partnerId: string): Promise<ReviewRecord[]>;
  listAdmin(status: ReviewQueryStatus, limit: number): Promise<ReviewRecord[]>;
  submit(clientId: string, authorName: string, bookingId: string, input: ReviewSubmitInput): Promise<ReviewRecord | null>;
  decide(reviewId: string, adminId: string, status: ReviewStatus, comment: string): Promise<ReviewRecord | null>;
  reply(partnerId: string, reviewId: string, body: string): Promise<ReviewRecord | null>;
}

export class ReviewActionError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: "REVIEW_NOT_ELIGIBLE" | "REVIEW_EXISTS" | "REVIEW_STATE_CHANGED" | "REVIEW_REPLY_FORBIDDEN",
    message: string,
  ) {
    super(message);
  }
}

function reviewEligibility(booking: BookingRecord, roomId: string, now: Date) {
  if (!["visited", "completed"].includes(booking.status) || new Date(booking.endsAt).getTime() > now.getTime()) {
    throw new ReviewActionError("REVIEW_NOT_ELIGIBLE", "Отзыв можно оставить только после завершённого посещения.");
  }
  const room = booking.rooms.find((item) => item.id === roomId || item.slug === roomId);
  if (!room) throw new ReviewActionError("REVIEW_NOT_ELIGIBLE", "Это помещение не относится к завершённой брони.");
  return room;
}

function reviewDate(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export class MemoryReviewRepository implements ReviewRepository {
  readonly storage = "memory" as const;
  private readonly records: ReviewRecord[] = [];

  constructor(
    private readonly bookings: BookingRepository,
    private readonly catalog: CatalogRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listPublicRoom(idOrSlug: string): Promise<PublicReview[] | null> {
    const room = await this.catalog.findRoom(idOrSlug);
    if (!room) return null;
    const seeded = await this.catalog.listRoomReviews(idOrSlug) ?? [];
    const submitted = this.records
      .filter((review) => review.roomId === room.id && review.status === "approved" && review.publishedAt)
      .map((review) => ({
        id: review.id,
        roomId: review.roomId,
        authorName: review.authorName,
        rating: review.rating,
        body: review.body,
        partnerReply: review.partnerReply,
        publishedAt: review.publishedAt!,
      }));
    return [...submitted, ...seeded].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  }

  async listByClient(clientId: string): Promise<ReviewRecord[]> {
    return this.copy(this.records.filter((review) => review.clientId === clientId));
  }

  async listByPartner(partnerId: string): Promise<ReviewRecord[]> {
    const venue = await this.bookings.getPartnerVenue(partnerId);
    if (!venue) return [];
    return this.copy(this.records.filter((review) => review.venueId === venue.id && review.status === "approved"));
  }

  async listAdmin(status: ReviewQueryStatus, limit: number): Promise<ReviewRecord[]> {
    return this.copy(this.records
      .filter((review) => status === "all" || review.status === status)
      .sort((left, right) => Number(right.status === "pending") - Number(left.status === "pending")
        || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit));
  }

  async submit(clientId: string, authorName: string, bookingId: string, input: ReviewSubmitInput): Promise<ReviewRecord | null> {
    const booking = await this.bookings.findByClient(clientId, bookingId);
    if (!booking) return null;
    const room = reviewEligibility(booking, input.roomId, this.now());
    const existing = this.records.find((review) => review.bookingId === bookingId);
    const timestamp = this.now().toISOString();
    if (existing) {
      if (existing.status !== "rejected") {
        throw new ReviewActionError("REVIEW_EXISTS", "По этой брони отзыв уже отправлен.");
      }
      Object.assign(existing, {
        roomId: room.id,
        roomSlug: room.slug,
        roomTitle: room.title,
        authorName: authorName.trim() || "Гость Rooms",
        rating: input.rating,
        body: input.body.trim(),
        status: "pending" as const,
        partnerReply: null,
        moderationComment: null,
        moderatedAt: null,
        publishedAt: null,
        updatedAt: timestamp,
      });
      return structuredClone(existing);
    }
    const review: ReviewRecord = {
      id: randomUUID(),
      bookingId,
      roomId: room.id,
      roomSlug: room.slug,
      roomTitle: room.title,
      venueId: booking.venue.id,
      venueTitle: booking.venue.title,
      clientId,
      authorName: authorName.trim() || "Гость Rooms",
      rating: input.rating,
      body: input.body.trim(),
      status: "pending",
      partnerReply: null,
      moderationComment: null,
      moderatedAt: null,
      publishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.unshift(review);
    return structuredClone(review);
  }

  async decide(reviewId: string, _adminId: string, status: ReviewStatus, comment: string): Promise<ReviewRecord | null> {
    const review = this.records.find((item) => item.id === reviewId);
    if (!review) return null;
    const timestamp = this.now().toISOString();
    review.status = status;
    review.moderationComment = comment.trim() || null;
    review.moderatedAt = status === "pending" ? null : timestamp;
    review.publishedAt = status === "approved" ? review.publishedAt ?? timestamp : null;
    review.updatedAt = timestamp;
    return structuredClone(review);
  }

  async reply(partnerId: string, reviewId: string, body: string): Promise<ReviewRecord | null> {
    const venue = await this.bookings.getPartnerVenue(partnerId);
    if (!venue) return null;
    const review = this.records.find((item) => item.id === reviewId && item.venueId === venue.id);
    if (!review) return null;
    if (review.status !== "approved") {
      throw new ReviewActionError("REVIEW_REPLY_FORBIDDEN", "Ответить можно только на опубликованный отзыв.");
    }
    review.partnerReply = body.trim();
    review.updatedAt = this.now().toISOString();
    return structuredClone(review);
  }

  private copy(records: ReviewRecord[]): ReviewRecord[] {
    return records.map((review) => structuredClone(review));
  }
}

interface ReviewRow extends QueryResultRow {
  id: string;
  booking_id: string;
  room_id: string;
  room_slug: string;
  room_title: string;
  venue_id: string;
  venue_title: string;
  client_id: string | null;
  author_name: string | null;
  rating: number | string;
  body: string | null;
  status: ReviewStatus;
  partner_reply: string | null;
  moderation_comment: string | null;
  moderated_at: Date | string | null;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LockedReviewRow extends QueryResultRow {
  id: string;
  room_id: string;
  rating: number;
  status: ReviewStatus;
}

const REVIEW_SELECT = `
  select review.id::text, review.booking_id::text, review.room_id::text,
    room.slug as room_slug, room.title as room_title,
    venue.id::text as venue_id, venue.title as venue_title,
    review.client_id::text, coalesce(nullif(split_part(trim(client.name), ' ', 1), ''), 'Гость Rooms') as author_name,
    review.rating, review.body, review.status::text, review.partner_reply,
    review.moderation_comment, review.moderated_at, review.published_at,
    review.created_at, review.updated_at
  from reviews review
  join rooms room on room.id = review.room_id
  join venues venue on venue.id = room.venue_id
  left join users client on client.id = review.client_id
`;

function recordFromRow(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    roomId: row.room_id,
    roomSlug: row.room_slug,
    roomTitle: row.room_title,
    venueId: row.venue_id,
    venueTitle: row.venue_title,
    clientId: row.client_id,
    authorName: row.author_name ?? "Гость Rooms",
    rating: Number(row.rating) || 0,
    body: row.body ?? "",
    status: row.status,
    partnerReply: row.partner_reply,
    moderationComment: row.moderation_comment,
    moderatedAt: reviewDate(row.moderated_at),
    publishedAt: reviewDate(row.published_at),
    createdAt: reviewDate(row.created_at)!,
    updatedAt: reviewDate(row.updated_at)!,
  };
}

export class PostgresReviewRepository implements ReviewRepository {
  readonly storage = "postgresql" as const;

  constructor(
    private readonly pool: Pool,
    private readonly bookings: BookingRepository,
    private readonly catalog: CatalogRepository,
  ) {}

  listPublicRoom(idOrSlug: string): Promise<PublicReview[] | null> {
    return this.catalog.listRoomReviews(idOrSlug);
  }

  async listByClient(clientId: string): Promise<ReviewRecord[]> {
    const result = await this.pool.query<ReviewRow>(`${REVIEW_SELECT}
      where review.client_id = $1::uuid
      order by review.updated_at desc, review.id`, [clientId]);
    return result.rows.map(recordFromRow);
  }

  async listByPartner(partnerId: string): Promise<ReviewRecord[]> {
    const result = await this.pool.query<ReviewRow>(`${REVIEW_SELECT}
      join venue_members member on member.venue_id = venue.id and member.user_id = $1::uuid
      where review.status = 'approved'
      order by review.published_at desc nulls last, review.created_at desc`, [partnerId]);
    return result.rows.map(recordFromRow);
  }

  async listAdmin(status: ReviewQueryStatus, limit: number): Promise<ReviewRecord[]> {
    const result = await this.pool.query<ReviewRow>(`${REVIEW_SELECT}
      where ($1 = 'all' or review.status::text = $1)
      order by (review.status = 'pending') desc, review.updated_at desc
      limit $2`, [status, limit]);
    return result.rows.map(recordFromRow);
  }

  async submit(clientId: string, authorName: string, bookingId: string, input: ReviewSubmitInput): Promise<ReviewRecord | null> {
    const booking = await this.bookings.findByClient(clientId, bookingId);
    if (!booking) return null;
    const room = reviewEligibility(booking, input.roomId, new Date());
    const client = await this.pool.connect();
    let reviewId = "";
    try {
      await client.query("begin");
      const existing = await client.query<{ id: string; status: ReviewStatus }>(
        "select id::text, status::text from reviews where booking_id = $1::uuid for update",
        [bookingId],
      );
      const current = existing.rows[0];
      if (current && current.status !== "rejected") {
        throw new ReviewActionError("REVIEW_EXISTS", "По этой брони отзыв уже отправлен.");
      }
      if (current) {
        reviewId = current.id;
        await client.query(`update reviews set room_id = $2::uuid, client_id = $3::uuid,
          rating = $4, body = $5, status = 'pending', partner_reply = null,
          moderation_comment = null, moderated_by = null, moderated_at = null,
          published_at = null, updated_at = now()
          where id = $1::uuid`, [reviewId, room.id, clientId, input.rating, input.body.trim()]);
      } else {
        reviewId = randomUUID();
        await client.query(`insert into reviews (
          id, booking_id, room_id, client_id, rating, body, status, created_at, updated_at
        ) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,'pending',now(),now())`,
        [reviewId, bookingId, room.id, clientId, input.rating, input.body.trim()]);
      }
      await this.audit(client, clientId, "client", current ? "review_resubmitted" : "review_submitted", reviewId,
        current ? { status: current.status } : {}, { bookingId, roomId: room.id, rating: input.rating, authorName });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findById(reviewId);
  }

  async decide(reviewId: string, adminId: string, status: ReviewStatus, comment: string): Promise<ReviewRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const currentResult = await client.query<LockedReviewRow>(`select id::text, room_id::text, rating, status::text
        from reviews where id = $1::uuid for update`, [reviewId]);
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("rollback");
        return null;
      }
      if (current.status === "approved" && status !== "approved") {
        await this.adjustRoomRating(client, current.room_id, current.rating, -1);
      } else if (current.status !== "approved" && status === "approved") {
        await this.adjustRoomRating(client, current.room_id, current.rating, 1);
      }
      await client.query(`update reviews set status = $2::moderation_status,
        moderation_comment = nullif($3,''),
        moderated_by = case when $2 = 'pending' then null else $4::uuid end,
        moderated_at = case when $2 = 'pending' then null else now() end,
        published_at = case when $2 = 'approved' then coalesce(published_at, now()) else null end,
        updated_at = now()
        where id = $1::uuid`, [reviewId, status, comment.trim(), adminId]);
      await this.audit(client, adminId, "admin", "review_moderated", reviewId,
        { status: current.status }, { status, comment: comment.trim() || null });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findById(reviewId);
  }

  async reply(partnerId: string, reviewId: string, body: string): Promise<ReviewRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query<{ id: string }>(`update reviews review set partner_reply = $3, updated_at = now()
        from rooms room
        where review.id = $2::uuid and review.room_id = room.id and review.status = 'approved'
          and exists (
            select 1 from venue_members member
            where member.venue_id = room.venue_id and member.user_id = $1::uuid
          )
        returning review.id::text`, [partnerId, reviewId, body.trim()]);
      if (!updated.rows[0]) {
        const exists = await client.query<{ exists: boolean }>("select exists(select 1 from reviews where id = $1::uuid) as exists", [reviewId]);
        if (exists.rows[0]?.exists) {
          throw new ReviewActionError("REVIEW_REPLY_FORBIDDEN", "Ответить можно только на опубликованный отзыв своей площадки.");
        }
        await client.query("rollback");
        return null;
      }
      await this.audit(client, partnerId, "partner", "review_partner_replied", reviewId, {}, { reply: body.trim() });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.findById(reviewId);
  }

  private async findById(reviewId: string): Promise<ReviewRecord | null> {
    const result = await this.pool.query<ReviewRow>(`${REVIEW_SELECT} where review.id = $1::uuid limit 1`, [reviewId]);
    return result.rows[0] ? recordFromRow(result.rows[0]) : null;
  }

  private async adjustRoomRating(client: PoolClient, roomId: string, rating: number, direction: 1 | -1): Promise<void> {
    if (direction === 1) {
      await client.query(`update rooms set
        rating_cached = ((rating_cached * review_count_cached) + $2) / (review_count_cached + 1),
        review_count_cached = review_count_cached + 1,
        updated_at = now()
        where id = $1::uuid`, [roomId, rating]);
      return;
    }
    await client.query(`update rooms set
      rating_cached = case when review_count_cached <= 1 then 0
        else greatest(0, ((rating_cached * review_count_cached) - $2) / (review_count_cached - 1)) end,
      review_count_cached = greatest(0, review_count_cached - 1),
      updated_at = now()
      where id = $1::uuid`, [roomId, rating]);
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    actorRole: "client" | "partner" | "admin",
    action: string,
    reviewId: string,
    beforeData: Record<string, unknown>,
    afterData: Record<string, unknown>,
  ): Promise<void> {
    await client.query(`insert into audit_log (
      actor_id, actor_role, action, entity_type, entity_id, before_data, after_data
    ) values ($1::uuid,$2::user_role,$3,'review',$4,$5::jsonb,$6::jsonb)`,
    [actorId, actorRole, action, reviewId, JSON.stringify(beforeData), JSON.stringify(afterData)]);
  }
}
