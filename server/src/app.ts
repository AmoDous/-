import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthConflictError, AuthService, MemoryAuthRepository, normalizeRussianPhone, passwordResetLifetimeSeconds, type AuthRepository, type IssuedAuthSession } from "./auth.js";
import { MemoryBookingRepository, type BookingRepository, type BookingStatusGroup, type PartnerBookingStatusGroup } from "./bookings.js";
import { MemoryCatalogRepository, type CatalogRepository } from "./catalog.js";
import { MemoryPaymentRepository, type PaymentRepository } from "./payments.js";
import {
  MemoryPartnerCatalogRepository,
  type AdminModerationQuery,
  type PartnerCatalogRepository,
  type PartnerRoomWrite,
  type PartnerScheduleExceptionWrite,
  type PartnerVenueWrite,
} from "./partnerCatalog.js";
import {
  MemoryPartnerReservationRepository,
  type ManualReservationSource,
  type PartnerReservationInput,
  type PartnerReservationRepository,
  type PartnerReservationType,
  type TechnicalCategory,
} from "./reservations.js";
import { availabilityForRoom, intersectAvailability, isIsoDate, MOSCOW_TIMEZONE, moscowToday } from "./availability.js";
import type {
  AvailabilityWindow,
  PublicReviewPage,
  PublicRoomDetail,
  PublicRoomSummary,
  Room,
  RoomSearchFilters,
  Venue,
} from "./types.js";

interface AppConfig {
  publicSiteUrl: string;
  corsOrigins: string[];
  logger: boolean;
  repository: CatalogRepository;
  authRepository: AuthRepository;
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  reservationRepository: PartnerReservationRepository;
  partnerCatalogRepository: PartnerCatalogRepository;
  authTokenSecret: string;
  secureCookies: boolean;
  enableDemoPayments: boolean;
  exposePasswordResetToken: boolean;
}

interface SearchQuery {
  city: string;
  date?: string;
  time?: string;
  durationMinutes?: number;
  guests?: number;
  type?: string;
  features?: string;
  maxPricePerHour?: number;
  sort?: "rating" | "price" | "capacity";
}

interface RoomParams {
  roomId: string;
}

interface CityParams {
  cityId: string;
}

interface RoomQuery {
  date?: string;
}

interface AvailabilityBody {
  roomIds: string[];
  date: string;
  durationMinutes: number;
  preferredTime?: string;
  guests?: number;
}

interface ClientRegistrationBody {
  name: string;
  email: string;
  phone: string;
  city: string;
  password: string;
  legal: {
    termsVersion: string;
    privacyVersion: string;
    acceptedAt: string;
  };
}

interface LoginBody {
  login: string;
  password: string;
}

interface PasswordResetRequestBody {
  login: string;
}

interface PasswordResetConfirmBody {
  token: string;
  newPassword: string;
}

interface SessionParams {
  sessionId: string;
}

interface ClientProfileBody {
  name: string;
  email: string;
  phone: string;
  city: string;
  currentPassword?: string;
  newPassword?: string;
}

interface BookingCreateBody {
  primaryRoomId: string;
  roomIds: string[];
  startsAt: string;
  durationMinutes: number;
  guests: number;
  eventType?: string | null;
  eventName?: string | null;
  serviceIds?: string[];
  onSitePaymentMethod?: "card" | "cash";
  comment?: string;
  legal: {
    termsVersion: string;
    privacyVersion: string;
    acceptedAt: string;
  };
}

interface BookingQuery {
  statusGroup?: BookingStatusGroup;
}

interface PartnerBookingQuery {
  statusGroup?: PartnerBookingStatusGroup;
}

interface BookingParams {
  bookingId: string;
}

interface PaymentParams {
  paymentId: string;
}

interface PartnerBookingRejectBody {
  reason: string;
}

interface PartnerBookingProposalBody {
  startsAt: string;
  durationMinutes: number;
  comment?: string;
}

interface BookingProposalActionBody {
  proposalId: string;
}

interface BookingMessageBody {
  body: string;
}

interface PartnerReservationBody {
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

interface PartnerReservationQuery {
  roomId?: string;
  dateFrom?: string;
  dateTo?: string;
  includeCancelled?: boolean;
}

interface ReservationParams {
  reservationId: string;
}

interface ReservationCancelBody {
  reason: string;
}

interface PartnerRoomParams {
  roomId: string;
}

interface PartnerScheduleDateParams {
  date: string;
}

interface AdminModerationParams {
  moderationId: string;
}

interface AdminModerationQuerystring {
  status?: AdminModerationQuery["status"];
  limit?: number;
}

interface AdminModerationDecisionBody {
  comment?: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assetContentTypes: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const partnerReservationBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["roomId", "type", "startsAt", "endsAt"],
  properties: {
    roomId: { type: "string", minLength: 36, maxLength: 36 },
    type: { type: "string", enum: ["manual_booking", "technical"] },
    category: { type: "string", enum: ["technical", "service", "private"] },
    startsAt: { type: "string", minLength: 20, maxLength: 40 },
    endsAt: { type: "string", minLength: 20, maxLength: 40 },
    clientName: { type: ["string", "null"], maxLength: 100 },
    clientPhone: { type: ["string", "null"], maxLength: 30 },
    guests: { type: ["integer", "null"], minimum: 1, maximum: 1000 },
    amount: { type: "number", minimum: 0, maximum: 100_000_000 },
    source: { type: ["string", "null"], enum: ["phone", "whatsapp", "telegram", "walk_in", "other", null] },
    comment: { type: "string", maxLength: 2000 },
  },
} as const;
const reservationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reservationId"],
  properties: { reservationId: { type: "string", minLength: 36, maxLength: 36 } },
} as const;
const partnerWeekScheduleDaySchema = {
  type: "object",
  additionalProperties: false,
  required: ["weekday", "enabled", "opensAtHour", "closesAtHour"],
  properties: {
    weekday: { type: "integer", minimum: 1, maximum: 7 },
    enabled: { type: "boolean" },
    opensAtHour: { type: "number", minimum: 0, maximum: 23.5, multipleOf: 0.5 },
    closesAtHour: { type: "number", minimum: 0.5, maximum: 30, multipleOf: 0.5 },
  },
} as const;
const partnerVenueWriteSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "city", "address", "venueType", "description", "rules", "contactName", "contactPhone",
    "contactEmail", "amenities", "paymentMethods", "weekSchedule",
  ],
  properties: {
    title: { type: "string", minLength: 2, maxLength: 160 },
    city: { type: "string", minLength: 2, maxLength: 100 },
    address: { type: "string", minLength: 3, maxLength: 300 },
    venueType: { type: "string", minLength: 2, maxLength: 120 },
    description: { type: "string", minLength: 10, maxLength: 5000 },
    rules: { type: "string", maxLength: 5000 },
    contactName: { type: "string", minLength: 2, maxLength: 120 },
    contactPhone: { type: "string", minLength: 6, maxLength: 30 },
    contactEmail: { type: "string", maxLength: 320 },
    amenities: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } },
    paymentMethods: {
      type: "array", minItems: 1, maxItems: 2, uniqueItems: true,
      items: { type: "string", enum: ["card", "cash"] },
    },
    weekSchedule: { type: "array", minItems: 7, maxItems: 7, items: partnerWeekScheduleDaySchema },
  },
} as const;
const partnerRoomWriteSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "subtitle", "type", "description", "rules", "promotion", "capacityMin", "capacityMax",
    "pricePerHour", "minimumHours", "bufferMinutes", "opensAtHour", "closesAtHour", "features", "tags",
    "services", "status",
  ],
  properties: {
    title: { type: "string", minLength: 2, maxLength: 160 },
    subtitle: { type: "string", minLength: 2, maxLength: 160 },
    type: { type: "string", minLength: 2, maxLength: 80 },
    description: { type: "string", minLength: 10, maxLength: 5000 },
    rules: { type: "string", maxLength: 5000 },
    promotion: { type: "string", maxLength: 2000 },
    capacityMin: { type: "integer", minimum: 1, maximum: 1000 },
    capacityMax: { type: "integer", minimum: 1, maximum: 1000 },
    pricePerHour: { type: "number", minimum: 0, maximum: 100_000_000 },
    minimumHours: { type: "number", minimum: 0.5, maximum: 24, multipleOf: 0.5 },
    bufferMinutes: { type: "integer", enum: [0, 15, 30, 45, 60] },
    opensAtHour: { type: "number", minimum: 0, maximum: 23.5, multipleOf: 0.5 },
    closesAtHour: { type: "number", minimum: 0.5, maximum: 30, multipleOf: 0.5 },
    features: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
    tags: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
    services: {
      type: "array", maxItems: 50,
      items: {
        type: "object", additionalProperties: false, required: ["name", "description", "price"],
        properties: {
          id: { type: "string", maxLength: 100 },
          name: { type: "string", minLength: 1, maxLength: 160 },
          description: { type: "string", maxLength: 1000 },
          price: { type: "number", minimum: 0, maximum: 100_000_000 },
        },
      },
    },
    status: { type: "string", enum: ["review", "published", "hidden"] },
  },
} as const;
const partnerScheduleDateParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["date"],
  properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
} as const;
const partnerScheduleExceptionWriteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "opensAtHour", "closesAtHour", "note"],
  properties: {
    mode: { type: "string", enum: ["closed", "custom"] },
    opensAtHour: { type: ["number", "null"], minimum: 0, maximum: 23.5, multipleOf: 0.5 },
    closesAtHour: { type: ["number", "null"], minimum: 0.5, maximum: 30, multipleOf: 0.5 },
    note: { type: "string", maxLength: 500 },
  },
} as const;

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: unknown[] = [],
  ) {
    super(message);
  }
}

class AuthAttemptLimiter {
  private readonly entries = new Map<string, { failures: number; resetAt: number }>();

  blocked(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return entry.failures >= 5;
  }

  fail(key: string): void {
    const current = this.entries.get(key);
    this.entries.set(key, current && current.resetAt > Date.now()
      ? { ...current, failures: current.failures + 1 }
      : { failures: 1, resetAt: Date.now() + 10 * 60 * 1000 });
  }

  clear(key: string): void {
    this.entries.delete(key);
  }
}

function email(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("ru-RU");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ? normalized : null;
}

function cookieValue(header: string | undefined, name: string): string | null {
  const item = String(header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!item) return null;
  try {
    return decodeURIComponent(item.slice(name.length + 1));
  } catch {
    return null;
  }
}

function refreshCookie(reply: FastifyReply, token: string, maxAge: number, secure: boolean): void {
  const security = secure ? "; Secure" : "";
  reply.header("Set-Cookie", `rooms_refresh=${encodeURIComponent(token)}; Path=/v1/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${security}`);
}

function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
  const security = secure ? "; Secure" : "";
  reply.header("Set-Cookie", `rooms_refresh=; Path=/v1/auth; HttpOnly; SameSite=Lax; Max-Age=0${security}`);
}

function authResponse(session: IssuedAuthSession) {
  return { user: session.user, accessToken: session.accessToken, expiresIn: session.expiresIn };
}

function moscowDateTime(value: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MOSCOW_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const item = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${item.year}-${item.month}-${item.day}`, time: `${item.hour}:${item.minute}` };
}

function moneyAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

function relativeMoscowHour(value: Date, baseDate: string): number {
  const local = moscowDateTime(value);
  const dayOffset = Math.round((Date.parse(`${local.date}T00:00:00Z`) - Date.parse(`${baseDate}T00:00:00Z`)) / 86_400_000);
  const [hours, minutes] = local.time.split(":").map(Number);
  return dayOffset * 24 + (hours ?? 0) + (minutes ?? 0) / 60;
}

function blockedChatContact(text: string): string | null {
  const lower = text.toLocaleLowerCase("ru-RU");
  if (/[a-zа-я0-9._%+-]+@[a-zа-я0-9.-]+\.[a-zа-я]{2,}/iu.test(text)) return "email";
  if (/(?:https?:\/\/|www\.|t\.me\/|wa\.me\/|[a-zа-я0-9-]+\.(?:ru|рф|com|net|org)\b)/iu.test(text)) return "ссылку";
  if (/(^|\s)@[a-zа-я0-9_]{3,}/iu.test(text) || /(telegram|телеграм|whatsapp|ватсап|viber|вайбер|instagram|инстаграм|вконтакте|\bvk\b)/iu.test(lower)) {
    return "контакт мессенджера";
  }
  const phoneLike = text.match(/\+?\d[\d\s()\-]{7,}\d/g) ?? [];
  return phoneLike.some((value) => (value.match(/\d/g) ?? []).length >= 10) ? "номер телефона" : null;
}

function photoUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

async function presentRoom(
  repository: CatalogRepository,
  room: Room,
  publicSiteUrl: string,
  date?: string,
  durationMinutes = room.minimumHours * 60,
  preferredTime?: string,
): Promise<PublicRoomSummary> {
  const venue = await repository.findVenue(room.venueId);
  if (!venue) throw new ApiError(404, "VENUE_NOT_FOUND", "Площадка помещения не найдена.");
  const nearestWindows = date
    ? (() => {
        const windows = availabilityForRoom(room, date, durationMinutes, preferredTime);
        const exact = windows.find((window) => window.exactMatch);
        return exact ? [exact, ...windows.filter((window) => window !== exact).slice(0, 3)] : windows.slice(0, 4);
      })()
    : [];
  return {
    id: room.id,
    slug: room.slug,
    venue,
    title: room.title,
    subtitle: room.subtitle,
    type: room.type,
    capacityMin: room.capacityMin,
    capacityMax: room.capacityMax,
    pricePerHour: room.pricePerHour,
    minimumHours: room.minimumHours,
    rating: room.rating,
    reviewCount: room.reviewCount,
    features: room.features,
    tags: room.tags,
    promotion: room.promotion,
    photos: room.photoPaths.map((path) => photoUrl(publicSiteUrl, path)),
    nearestWindows,
  };
}

function normalizeFilters(query: SearchQuery): RoomSearchFilters {
  if (query.date && !isIsoDate(query.date)) throw new ApiError(400, "INVALID_DATE", "Дата должна существовать и иметь формат YYYY-MM-DD.");
  if (query.time && !query.date) throw new ApiError(400, "DATE_REQUIRED", "Для поиска по времени сначала укажите дату.");
  return {
    city: query.city.trim(),
    durationMinutes: query.durationMinutes ?? 120,
    features: String(query.features ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    sort: query.sort ?? "rating",
    ...(query.date ? { date: query.date } : {}),
    ...(query.time ? { time: query.time } : {}),
    ...(query.guests !== undefined ? { guests: query.guests } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.maxPricePerHour !== undefined ? { maxPricePerHour: query.maxPricePerHour } : {}),
  };
}

function errorPayload(code: string, message: string, details: unknown[] = []) {
  return { code, message, details, requestId: null };
}

export function buildApp(overrides: Partial<AppConfig> = {}): FastifyInstance {
  const repository = overrides.repository ?? new MemoryCatalogRepository();
  const bookingRepository = overrides.bookingRepository ?? new MemoryBookingRepository();
  const paymentRepository = overrides.paymentRepository
    ?? (bookingRepository instanceof MemoryBookingRepository ? new MemoryPaymentRepository(bookingRepository) : null);
  if (!paymentRepository) throw new Error("paymentRepository is required with a non-memory booking repository.");
  const reservationRepository = overrides.reservationRepository
    ?? (bookingRepository instanceof MemoryBookingRepository ? new MemoryPartnerReservationRepository(bookingRepository, repository) : null);
  if (!reservationRepository) throw new Error("reservationRepository is required with a non-memory booking repository.");
  const partnerCatalogRepository = overrides.partnerCatalogRepository ?? new MemoryPartnerCatalogRepository();
  const config: AppConfig = {
    publicSiteUrl: overrides.publicSiteUrl ?? "https://amodous.github.io/Rooms-bron",
    corsOrigins: overrides.corsOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:4173", "http://127.0.0.1:4173", "https://amodous.github.io"],
    logger: overrides.logger ?? false,
    repository,
    authRepository: overrides.authRepository ?? new MemoryAuthRepository(),
    bookingRepository,
    paymentRepository,
    reservationRepository,
    partnerCatalogRepository,
    authTokenSecret: overrides.authTokenSecret ?? "rooms-local-development-secret-change-me-2026",
    secureCookies: overrides.secureCookies ?? false,
    enableDemoPayments: overrides.enableDemoPayments ?? true,
    exposePasswordResetToken: overrides.exposePasswordResetToken ?? false,
  };
  const app = Fastify({ logger: config.logger });
  const auth = new AuthService(config.authRepository, config.authTokenSecret);
  const authAttempts = new AuthAttemptLimiter();
  const passwordResetAttempts = new AuthAttemptLimiter();
  const passwordResetConfirmAttempts = new AuthAttemptLimiter();

  const requirePartnerVenue = async (authorization: string | undefined) => {
    const current = await auth.authenticate(authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const assigned = await config.bookingRepository.getPartnerVenue(current.user.id);
    if (!assigned) throw new ApiError(404, "PARTNER_VENUE_NOT_FOUND", "Для этого кабинета площадка ещё не назначена.");
    return { actorId: current.user.id, venueId: assigned.id };
  };

  const requireAdmin = async (authorization: string | undefined) => {
    const current = await auth.authenticate(authorization);
    if (!current) throw new ApiError(401, "UNAUTHORIZED", "Войдите в админку Rooms.");
    if (current.user.role !== "admin") throw new ApiError(403, "ADMIN_FORBIDDEN", "Этот раздел доступен только администратору Rooms.");
    return current.user;
  };

  const validatePartnerVenueWrite = (body: PartnerVenueWrite) => {
    const weekdays = new Set(body.weekSchedule.map((day) => day.weekday));
    if (weekdays.size !== 7 || [...weekdays].some((weekday) => weekday < 1 || weekday > 7)) {
      throw new ApiError(400, "INVALID_WEEK_SCHEDULE", "Укажите график для каждого дня недели.");
    }
    const invalid = body.weekSchedule.find((day) => day.enabled && day.closesAtHour <= day.opensAtHour);
    if (invalid) throw new ApiError(400, "INVALID_WEEK_SCHEDULE", `В дне недели ${invalid.weekday} закрытие должно быть позже открытия.`);
    return body;
  };

  const validatePartnerRoomWrite = (body: PartnerRoomWrite) => {
    if (body.capacityMax < body.capacityMin) {
      throw new ApiError(400, "INVALID_ROOM_CAPACITY", "Максимальная вместимость не может быть меньше минимальной.");
    }
    if (body.closesAtHour <= body.opensAtHour) {
      throw new ApiError(400, "INVALID_ROOM_SCHEDULE", "Закрытие помещения должно быть позже открытия.");
    }
    return body;
  };

  const withReservationBlocks = async (rooms: Room[], date: string): Promise<Room[]> => {
    if (config.repository.storage !== "memory" || !rooms.length) return rooms;
    const blocks = await config.reservationRepository.blocksByDate(rooms.map((room) => room.id), date);
    return rooms.map((room) => ({
      ...room,
      blockedByDate: { ...room.blockedByDate, [date]: [...(room.blockedByDate[date] ?? []), ...(blocks[room.id] ?? [])] },
    }));
  };

  const validateBookingProposal = async (partnerId: string, bookingId: string, body: PartnerBookingProposalBody) => {
    const booking = await config.bookingRepository.findByPartner(partnerId, bookingId);
    if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена в очереди этой площадки.");
    if (!["pending", "proposed"].includes(booking.status)) {
      throw new ApiError(409, "BOOKING_STATE_CHANGED", "Для этой заявки уже нельзя предложить другое время.");
    }
    const startsAt = new Date(body.startsAt);
    if (!Number.isFinite(startsAt.getTime())) throw new ApiError(400, "INVALID_START", "Проверьте дату и время начала.");
    if (startsAt.getTime() < Date.now()) throw new ApiError(400, "START_IN_PAST", "Нельзя предложить прошедшее время.");
    const localStart = moscowDateTime(startsAt);
    const found = await Promise.all(booking.rooms.map((room) => config.repository.findRoom(room.id, localStart.date)));
    if (found.some((room) => room === null)) throw new ApiError(404, "ROOM_NOT_FOUND", "Одно из помещений заявки больше недоступно.");
    const selectedRooms = await withReservationBlocks(found as Room[], localStart.date);
    if (selectedRooms.some((room) => room.venueId !== booking.venue.id)) {
      throw new ApiError(409, "BOOKING_ROOMS_CHANGED", "Состав помещений изменился. Обновите заявку.");
    }
    if (body.durationMinutes < Math.max(...selectedRooms.map((room) => room.minimumHours * 60))) {
      throw new ApiError(400, "MINIMUM_DURATION", "Предложенная длительность меньше минимальной для одного из помещений.");
    }
    const windows = intersectAvailability(
      selectedRooms.map((room) => availabilityForRoom(room, localStart.date, body.durationMinutes, localStart.time)),
      body.durationMinutes,
      localStart.time,
    );
    if (!windows.some((window) => new Date(window.startsAt).getTime() === startsAt.getTime())) {
      throw new ApiError(409, "SLOT_UNAVAILABLE", "Это время уже недоступно. Выберите другое окно.", windows.slice(0, 6));
    }
    const hours = body.durationMinutes / 60;
    const roomTotal = moneyAmount(booking.rooms.reduce((sum, room) => sum + room.pricePerHour * hours, 0));
    const serviceTotal = booking.money.serviceTotal;
    const total = moneyAmount(roomTotal + serviceTotal);
    const prepayment = Math.ceil(total * 0.3);
    const commission = Math.ceil(total * 0.15);
    return {
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + body.durationMinutes * 60_000).toISOString(),
      comment: body.comment?.trim() || "Площадка предложила другое свободное окно.",
      money: {
        roomTotal,
        serviceTotal,
        total,
        prepayment,
        remainingOnSite: moneyAmount(total - prepayment),
        currency: "RUB" as const,
      },
      commission,
      partnerAmount: moneyAmount(total - commission),
    };
  };

  const validatePartnerReservation = async (partnerId: string, body: PartnerReservationBody): Promise<PartnerReservationInput> => {
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
      throw new ApiError(400, "INVALID_RESERVATION_TIME", "Проверьте дату и время занятости.");
    }
    const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
    if (durationMinutes < 30 || durationMinutes > 1440 || !Number.isInteger(durationMinutes / 30)) {
      throw new ApiError(400, "INVALID_RESERVATION_DURATION", "Интервал должен длиться от 30 минут до 24 часов с шагом 30 минут.");
    }
    if (startsAt.getTime() < Date.now() - 5 * 60_000) throw new ApiError(400, "RESERVATION_IN_PAST", "Нельзя занять помещение в прошедшем времени.");
    const startLocal = moscowDateTime(startsAt);
    const [venue, room] = await Promise.all([
      config.bookingRepository.getPartnerVenue(partnerId),
      config.repository.findRoom(body.roomId, startLocal.date),
    ]);
    if (!venue || !room || room.venueId !== venue.id) throw new ApiError(404, "PARTNER_ROOM_NOT_FOUND", "Помещение не найдено в кабинете этой площадки.");
    const startHour = relativeMoscowHour(startsAt, startLocal.date);
    const endHour = relativeMoscowHour(endsAt, startLocal.date);
    if (room.closesAtHour <= room.opensAtHour || startHour < room.opensAtHour || endHour > room.closesAtHour) {
      throw new ApiError(409, "RESERVATION_OUTSIDE_SCHEDULE", "Интервал находится вне рабочего времени помещения.");
    }
    const manual = body.type === "manual_booking";
    const clientName = body.clientName?.trim() || null;
    const clientPhone = body.clientPhone ? normalizeRussianPhone(body.clientPhone) : null;
    if (manual && (!clientName || clientName.length < 2)) throw new ApiError(400, "CLIENT_NAME_REQUIRED", "Укажите имя клиента для ручной брони.");
    if (manual && !clientPhone) throw new ApiError(400, "CLIENT_PHONE_REQUIRED", "Укажите российский номер клиента.");
    return {
      roomId: room.id,
      type: body.type,
      ...(!manual ? { category: body.category ?? "technical" } : {}),
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      clientName,
      clientPhone,
      guests: manual ? Math.max(1, Number(body.guests) || 1) : null,
      amount: manual ? moneyAmount(Math.max(0, Number(body.amount) || 0)) : 0,
      source: manual ? body.source ?? "phone" : null,
      comment: body.comment?.trim() ?? "",
    };
  };

  void app.register(cors, {
    origin: config.corsOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  });

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ ...errorPayload(error.code, error.message, error.details), requestId: request.id });
    }
    if (error instanceof AuthConflictError) {
      return reply.status(409).send({ ...errorPayload("ACCOUNT_EXISTS", "Кабинет с такой почтой или телефоном уже существует."), requestId: request.id });
    }
    if ("validation" in error && error.validation) {
      return reply.status(400).send({
        ...errorPayload("VALIDATION_ERROR", "Проверьте параметры запроса.", error.validation),
        requestId: request.id,
      });
    }
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ ...errorPayload(error.code ?? "REQUEST_ERROR", error.message), requestId: request.id });
    }
    request.log.error(error);
    return reply.status(500).send({ ...errorPayload("INTERNAL_ERROR", "Не удалось обработать запрос."), requestId: request.id });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({ ...errorPayload("ROUTE_NOT_FOUND", "Маршрут API не найден."), requestId: request.id });
  });

  app.get("/", async (_request, reply) => {
    const html = await readFile(resolve(projectRoot, "index.html"));
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(html);
  });

  app.get<{ Params: { assetName: string } }>("/assets/:assetName", {
    schema: {
      params: {
        type: "object",
        required: ["assetName"],
        properties: { assetName: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*\\.(jpg|jpeg|png|webp|svg)$" } },
      },
    },
  }, async (request, reply) => {
    const extension = request.params.assetName.split(".").pop()?.toLowerCase() ?? "";
    const asset = await readFile(resolve(projectRoot, "assets", request.params.assetName));
    return reply.header("Cache-Control", "public, max-age=3600").type(assetContentTypes[extension] ?? "application/octet-stream").send(asset);
  });

  app.get("/health", async () => ({
    status: "ok",
    database: config.repository.storage === "postgresql" ? "up" : "down",
    storage: config.repository.storage,
    time: new Date().toISOString(),
  }));

  app.get("/v1/cities", async () => config.repository.listCities());

  app.post<{ Body: ClientRegistrationBody }>("/v1/auth/client/register", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "phone", "city", "password", "legal"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 100 },
          email: { type: "string", minLength: 5, maxLength: 254 },
          phone: { type: "string", minLength: 10, maxLength: 30 },
          city: { type: "string", minLength: 2, maxLength: 100 },
          password: { type: "string", minLength: 8, maxLength: 128 },
          legal: {
            type: "object",
            additionalProperties: false,
            required: ["termsVersion", "privacyVersion", "acceptedAt"],
            properties: {
              termsVersion: { type: "string", minLength: 1, maxLength: 100 },
              privacyVersion: { type: "string", minLength: 1, maxLength: 100 },
              acceptedAt: { type: "string", minLength: 20, maxLength: 40 },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    const normalizedEmail = email(body.email);
    const normalizedPhone = normalizeRussianPhone(body.phone);
    const acceptedAt = new Date(body.legal.acceptedAt);
    if (!normalizedEmail) throw new ApiError(400, "INVALID_EMAIL", "Проверьте электронную почту.");
    if (!normalizedPhone) throw new ApiError(400, "INVALID_PHONE", "Укажите российский номер телефона.");
    if (!Number.isFinite(acceptedAt.getTime()) || acceptedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new ApiError(400, "INVALID_CONSENT_DATE", "Не удалось подтвердить дату согласия.");
    }
    const session = await auth.register({
      name: body.name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      city: body.city.trim(),
      password: body.password,
      legal: { ...body.legal, acceptedAt: acceptedAt.toISOString() },
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    refreshCookie(reply, session.refreshToken, session.refreshExpiresIn, config.secureCookies);
    return reply.code(201).send(authResponse(session));
  });

  app.post<{ Body: LoginBody }>("/v1/auth/login", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["login", "password"],
        properties: {
          login: { type: "string", minLength: 3, maxLength: 254 },
          password: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const login = request.body.login.trim();
    const attemptKey = `${request.ip}|${login.toLocaleLowerCase("ru-RU")}`;
    if (authAttempts.blocked(attemptKey)) throw new ApiError(429, "LOGIN_RATE_LIMITED", "Слишком много попыток. Повторите вход через 10 минут.");
    const session = await auth.login(login, request.body.password, request.ip, request.headers["user-agent"] ?? null);
    if (!session) {
      authAttempts.fail(attemptKey);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Неверная почта, телефон или пароль.");
    }
    authAttempts.clear(attemptKey);
    refreshCookie(reply, session.refreshToken, session.refreshExpiresIn, config.secureCookies);
    return authResponse(session);
  });

  app.post<{ Body: PasswordResetRequestBody }>("/v1/auth/password-reset/request", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["login"],
        properties: { login: { type: "string", minLength: 3, maxLength: 254 } },
      },
    },
  }, async (request, reply) => {
    const login = request.body.login.trim();
    const attemptKey = `password-reset|${request.ip}`;
    if (passwordResetAttempts.blocked(attemptKey)) {
      throw new ApiError(429, "PASSWORD_RESET_RATE_LIMITED", "Слишком много запросов. Попробуйте снова через 10 минут.");
    }
    passwordResetAttempts.fail(attemptKey);
    const token = await auth.requestPasswordReset(login, request.ip, request.headers["user-agent"] ?? null);
    const payload: Record<string, unknown> = {
      accepted: true,
      expiresIn: passwordResetLifetimeSeconds,
      message: "Если кабинет найден, ссылка для смены пароля уже отправлена.",
    };
    if (config.exposePasswordResetToken) {
      const resetUrl = new URL(config.publicSiteUrl);
      resetUrl.searchParams.set("reset", token);
      payload.demoToken = token;
      payload.demoResetUrl = resetUrl.toString();
    }
    return reply.code(202).send(payload);
  });

  app.post<{ Body: PasswordResetConfirmBody }>("/v1/auth/password-reset/confirm", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["token", "newPassword"],
        properties: {
          token: { type: "string", minLength: 32, maxLength: 200 },
          newPassword: { type: "string", minLength: 8, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const attemptKey = `password-reset-confirm|${request.ip}`;
    if (passwordResetConfirmAttempts.blocked(attemptKey)) {
      throw new ApiError(429, "PASSWORD_RESET_RATE_LIMITED", "Слишком много попыток. Попробуйте снова через 10 минут.");
    }
    const completed = await auth.resetPassword(request.body.token, request.body.newPassword);
    if (!completed) {
      passwordResetConfirmAttempts.fail(attemptKey);
      throw new ApiError(400, "PASSWORD_RESET_INVALID", "Ссылка устарела или уже была использована.");
    }
    passwordResetConfirmAttempts.clear(attemptKey);
    clearRefreshCookie(reply, config.secureCookies);
    return reply.code(204).send();
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const token = cookieValue(request.headers.cookie, "rooms_refresh");
    const session = token ? await auth.refresh(token, request.ip, request.headers["user-agent"] ?? null) : null;
    if (!session) {
      clearRefreshCookie(reply, config.secureCookies);
      throw new ApiError(401, "SESSION_EXPIRED", "Сессия завершена. Войдите снова.");
    }
    refreshCookie(reply, session.refreshToken, session.refreshExpiresIn, config.secureCookies);
    return authResponse(session);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = cookieValue(request.headers.cookie, "rooms_refresh");
    await auth.logout(request.headers.authorization, token);
    clearRefreshCookie(reply, config.secureCookies);
    return reply.code(204).send();
  });

  app.get("/v1/me", async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current) throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет.");
    return current.user;
  });

  app.get("/v1/me/sessions", async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current) throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет.");
    return { items: await auth.listSessions(current.user.id, current.sessionId) };
  });

  app.delete("/v1/me/sessions/others", async (request, reply) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current) throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет.");
    await auth.revokeOtherUserSessions(current.user.id, current.sessionId);
    return reply.code(204).send();
  });

  app.delete<{ Params: SessionParams }>("/v1/me/sessions/:sessionId", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" },
        },
      },
    },
  }, async (request, reply) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current) throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет.");
    const revoked = await auth.revokeUserSession(current.user.id, request.params.sessionId);
    if (!revoked) throw new ApiError(404, "SESSION_NOT_FOUND", "Активная сессия не найдена.");
    if (current.sessionId === request.params.sessionId) clearRefreshCookie(reply, config.secureCookies);
    return reply.code(204).send();
  });

  app.patch<{ Body: ClientProfileBody }>("/v1/me", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "phone", "city"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 100 },
          email: { type: "string", minLength: 5, maxLength: 254 },
          phone: { type: "string", minLength: 10, maxLength: 30 },
          city: { type: "string", minLength: 2, maxLength: 100 },
          currentPassword: { type: "string", minLength: 1, maxLength: 128 },
          newPassword: { type: "string", minLength: 8, maxLength: 128 },
        },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "client") throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет клиента.");
    const normalizedEmail = email(request.body.email);
    const normalizedPhone = normalizeRussianPhone(request.body.phone);
    if (!normalizedEmail) throw new ApiError(400, "INVALID_EMAIL", "Проверьте электронную почту.");
    if (!normalizedPhone) throw new ApiError(400, "INVALID_PHONE", "Укажите российский номер телефона.");
    if (request.body.newPassword && !request.body.currentPassword) {
      throw new ApiError(400, "CURRENT_PASSWORD_REQUIRED", "Для смены пароля укажите текущий пароль.");
    }
    const updated = await auth.updateClientProfile(current.user.id, current.sessionId, {
      name: request.body.name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      city: request.body.city.trim(),
      ...(request.body.currentPassword ? { currentPassword: request.body.currentPassword } : {}),
      ...(request.body.newPassword ? { newPassword: request.body.newPassword } : {}),
    });
    if (!updated) throw new ApiError(401, "CURRENT_PASSWORD_INVALID", "Текущий пароль не подходит.");
    return updated;
  });

  app.get<{ Querystring: BookingQuery }>("/v1/bookings", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          statusGroup: { type: "string", enum: ["active", "completed", "cancelled", "all"] },
        },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "client") throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет клиента.");
    return config.bookingRepository.listByClient(current.user.id, request.query.statusGroup ?? "all");
  });

  app.get<{ Params: BookingParams }>("/v1/bookings/:bookingId/messages", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || (current.user.role !== "client" && current.user.role !== "partner")) {
      throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет участника заявки.");
    }
    const messages = await config.bookingRepository.listMessages(current.user.id, current.user.role, request.params.bookingId);
    if (!messages) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена или недоступна этому кабинету.");
    return messages;
  });

  app.post<{ Params: BookingParams; Body: BookingMessageBody }>("/v1/bookings/:bookingId/messages", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: { type: "string", minLength: 1, maxLength: 1000 } },
      },
    },
  }, async (request, reply) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || (current.user.role !== "client" && current.user.role !== "partner")) {
      throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет участника заявки.");
    }
    const booking = current.user.role === "client"
      ? await config.bookingRepository.findByClient(current.user.id, request.params.bookingId)
      : await config.bookingRepository.findByPartner(current.user.id, request.params.bookingId);
    if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена или недоступна этому кабинету.");
    const body = request.body.body.trim();
    if (!body) throw new ApiError(400, "MESSAGE_REQUIRED", "Введите сообщение.");
    const blocked = booking.status !== "paid" ? blockedChatContact(body) : null;
    if (blocked) throw new ApiError(422, "CONTACT_DETAILS_BLOCKED", `До предоплаты нельзя передавать ${blocked}.`);
    const message = await config.bookingRepository.addMessage(current.user.id, current.user.role, request.params.bookingId, body);
    if (!message) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена или недоступна этому кабинету.");
    return reply.code(201).send(message);
  });

  app.post<{ Params: BookingParams; Body: BookingProposalActionBody }>("/v1/bookings/:bookingId/proposal/accept", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["proposalId"],
        properties: { proposalId: { type: "string", minLength: 36, maxLength: 36 } },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "client") throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет клиента.");
    const booking = await config.bookingRepository.acceptProposalByClient(current.user.id, request.params.bookingId, request.body.proposalId);
    if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена в личном кабинете.");
    return booking;
  });

  app.post<{ Params: BookingParams; Body: BookingProposalActionBody }>("/v1/bookings/:bookingId/proposal/decline", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["proposalId"],
        properties: { proposalId: { type: "string", minLength: 36, maxLength: 36 } },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "client") throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет клиента.");
    const booking = await config.bookingRepository.declineProposalByClient(current.user.id, request.params.bookingId, request.body.proposalId);
    if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена в личном кабинете.");
    return booking;
  });

  app.post<{ Body: BookingCreateBody }>("/v1/bookings", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["primaryRoomId", "roomIds", "startsAt", "durationMinutes", "guests", "legal"],
        properties: {
          primaryRoomId: { type: "string", minLength: 1, maxLength: 100 },
          roomIds: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
          startsAt: { type: "string", minLength: 20, maxLength: 40 },
          durationMinutes: { type: "integer", minimum: 30, maximum: 1440, multipleOf: 30 },
          guests: { type: "integer", minimum: 1, maximum: 1000 },
          eventType: { type: ["string", "null"], maxLength: 100 },
          eventName: { type: ["string", "null"], maxLength: 200 },
          serviceIds: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
          onSitePaymentMethod: { type: "string", enum: ["card", "cash"] },
          comment: { type: "string", maxLength: 2000 },
          legal: {
            type: "object",
            additionalProperties: false,
            required: ["termsVersion", "privacyVersion", "acceptedAt"],
            properties: {
              termsVersion: { type: "string", minLength: 1, maxLength: 100 },
              privacyVersion: { type: "string", minLength: 1, maxLength: 100 },
              acceptedAt: { type: "string", minLength: 20, maxLength: 40 },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "client") throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет клиента.");
    if (!current.user.phone) throw new ApiError(400, "CLIENT_PHONE_REQUIRED", "Добавьте телефон в личном кабинете перед бронированием.");
    const body = request.body;
    if (!body.roomIds.includes(body.primaryRoomId)) throw new ApiError(400, "PRIMARY_ROOM_REQUIRED", "Основное помещение должно входить в состав брони.");
    const startsAt = new Date(body.startsAt);
    if (!Number.isFinite(startsAt.getTime())) throw new ApiError(400, "INVALID_START", "Проверьте дату и время начала.");
    if (startsAt.getTime() < Date.now()) throw new ApiError(400, "START_IN_PAST", "Нельзя создать заявку на прошедшее время.");
    const acceptedAt = new Date(body.legal.acceptedAt);
    if (!Number.isFinite(acceptedAt.getTime()) || acceptedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new ApiError(400, "INVALID_CONSENT_DATE", "Не удалось подтвердить дату согласия.");
    }
    const localStart = moscowDateTime(startsAt);
    const found = await Promise.all(body.roomIds.map((id) => config.repository.findRoom(id, localStart.date)));
    if (found.some((room) => room === null)) throw new ApiError(404, "ROOM_NOT_FOUND", "Одно из помещений не найдено или временно скрыто.");
    const selectedRooms = await withReservationBlocks(found as Room[], localStart.date);
    const venueIds = new Set(selectedRooms.map((room) => room.venueId));
    if (venueIds.size !== 1) throw new ApiError(400, "VENUE_MISMATCH", "В одной заявке можно выбрать помещения только одной площадки.");
    if (body.durationMinutes < Math.max(...selectedRooms.map((room) => room.minimumHours * 60))) {
      throw new ApiError(400, "MINIMUM_DURATION", "Выбранная длительность меньше минимальной для одного из помещений.");
    }
    const capacity = selectedRooms.reduce((sum, room) => sum + room.capacityMax, 0);
    if (body.guests > capacity) throw new ApiError(400, "CAPACITY_EXCEEDED", `Для выбранных помещений доступно до ${capacity} гостей.`);
    const windows = intersectAvailability(
      selectedRooms.map((room) => availabilityForRoom(room, localStart.date, body.durationMinutes, localStart.time)),
      body.durationMinutes,
      localStart.time,
    );
    const selectedWindow = windows.find((window) => new Date(window.startsAt).getTime() === startsAt.getTime());
    if (!selectedWindow) throw new ApiError(409, "SLOT_UNAVAILABLE", "Выбранное время уже недоступно. Выберите другое окно.", windows.slice(0, 6));
    const venue = await config.repository.findVenue(selectedRooms[0]!.venueId);
    if (!venue) throw new ApiError(404, "VENUE_NOT_FOUND", "Площадка не найдена или временно скрыта.");
    const method = body.onSitePaymentMethod ?? venue.paymentMethods[0] ?? "card";
    if (!venue.paymentMethods.includes(method)) throw new ApiError(400, "PAYMENT_METHOD_UNAVAILABLE", "Площадка не поддерживает выбранный способ оплаты остатка.");
    const serviceIds = body.serviceIds ?? [];
    const availableServices = new Map(selectedRooms.flatMap((room) => room.services.map((service) => [service.id, service] as const)));
    const unknownService = serviceIds.find((id) => !availableServices.has(id));
    if (unknownService) throw new ApiError(400, "SERVICE_NOT_FOUND", "Одна из дополнительных услуг больше недоступна.");
    const hours = body.durationMinutes / 60;
    const bookingRooms = selectedRooms.map((room) => ({
      id: room.id,
      slug: room.slug,
      title: room.title,
      type: room.type,
      capacityMax: room.capacityMax,
      pricePerHour: room.pricePerHour,
      amount: moneyAmount(room.pricePerHour * hours),
      isPrimary: room.id === body.primaryRoomId,
      bufferMinutes: room.bufferMinutes,
    }));
    const bookingServices = serviceIds.map((id) => {
      const service = availableServices.get(id)!;
      return { id: service.id, name: service.name, description: service.description, price: service.price, quantity: 1, amount: service.price };
    });
    const roomTotal = moneyAmount(bookingRooms.reduce((sum, room) => sum + room.amount, 0));
    const serviceTotal = moneyAmount(bookingServices.reduce((sum, service) => sum + service.amount, 0));
    const total = moneyAmount(roomTotal + serviceTotal);
    const prepayment = Math.ceil(total * 0.3);
    const commission = Math.ceil(total * 0.15);
    const endsAt = new Date(startsAt.getTime() + body.durationMinutes * 60 * 1000).toISOString();
    const booking = await config.bookingRepository.create({
      clientId: current.user.id,
      clientName: current.user.name,
      clientPhone: current.user.phone,
      clientEmail: current.user.email,
      venue,
      rooms: bookingRooms,
      services: bookingServices,
      startsAt: startsAt.toISOString(),
      endsAt,
      guests: body.guests,
      eventType: body.eventType?.trim() || null,
      eventName: body.eventName?.trim() || null,
      onSitePaymentMethod: method,
      comment: body.comment?.trim() ?? "",
      money: { roomTotal, serviceTotal, total, prepayment, remainingOnSite: moneyAmount(total - prepayment), currency: "RUB" },
      commission,
      partnerAmount: moneyAmount(total - commission),
      legal: { ...body.legal, acceptedAt: acceptedAt.toISOString() },
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    return reply.code(201).send(booking);
  });

  app.post<{ Params: BookingParams }>("/v1/bookings/:bookingId/payment-intent", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
    },
  }, async (request, reply) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "client") throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет клиента.");
    if (!config.enableDemoPayments) throw new ApiError(503, "PAYMENTS_NOT_CONFIGURED", "Онлайн-оплата временно недоступна.");
    const payment = await config.paymentRepository.createIntent(current.user.id, request.params.bookingId);
    return reply.code(201).send(payment);
  });

  app.post<{ Params: PaymentParams }>("/v1/payments/:paymentId/demo-complete", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["paymentId"],
        properties: { paymentId: { type: "string", minLength: 36, maxLength: 36 } },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "client") throw new ApiError(401, "UNAUTHORIZED", "Войдите в личный кабинет клиента.");
    if (!config.enableDemoPayments) throw new ApiError(404, "DEMO_PAYMENTS_DISABLED", "Демонстрационный платёжный маршрут отключён.");
    const payment = await config.paymentRepository.completeDemo(current.user.id, request.params.paymentId);
    const booking = (await config.bookingRepository.listByClient(current.user.id, "all")).find((item) => item.id === payment.bookingId);
    if (!booking) throw new ApiError(409, "BOOKING_STATE_CHANGED", "Статус брони изменился. Обновите личный кабинет.");
    return { payment, booking };
  });

  app.get<{ Querystring: AdminModerationQuerystring }>("/v1/admin/moderation", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["pending", "approved", "rejected", "all"], default: "all" },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 80 },
        },
      },
    },
  }, async (request) => {
    await requireAdmin(request.headers.authorization);
    return config.partnerCatalogRepository.listModeration({
      status: request.query.status ?? "all",
      limit: request.query.limit ?? 80,
    });
  });

  const moderationParamsSchema = {
    type: "object",
    additionalProperties: false,
    required: ["moderationId"],
    properties: { moderationId: { type: "string", minLength: 36, maxLength: 36 } },
  } as const;
  const moderationDecisionBodySchema = {
    type: "object",
    additionalProperties: false,
    properties: { comment: { type: "string", maxLength: 1000 } },
  } as const;

  app.post<{ Params: AdminModerationParams; Body: AdminModerationDecisionBody }>("/v1/admin/moderation/:moderationId/approve", {
    schema: { params: moderationParamsSchema, body: moderationDecisionBodySchema },
  }, async (request) => {
    const admin = await requireAdmin(request.headers.authorization);
    const item = await config.partnerCatalogRepository.decideModeration(
      request.params.moderationId,
      admin.id,
      "approved",
      request.body?.comment?.trim() ?? "",
    );
    if (!item) throw new ApiError(404, "MODERATION_NOT_FOUND", "Изменение для модерации не найдено.");
    return item;
  });

  app.post<{ Params: AdminModerationParams; Body: AdminModerationDecisionBody }>("/v1/admin/moderation/:moderationId/reject", {
    schema: { params: moderationParamsSchema, body: moderationDecisionBodySchema },
  }, async (request) => {
    const admin = await requireAdmin(request.headers.authorization);
    const comment = request.body?.comment?.trim() ?? "";
    if (comment.length < 3) throw new ApiError(400, "REVIEW_COMMENT_REQUIRED", "Укажите причину отклонения для партнёра.");
    const item = await config.partnerCatalogRepository.decideModeration(
      request.params.moderationId,
      admin.id,
      "rejected",
      comment,
    );
    if (!item) throw new ApiError(404, "MODERATION_NOT_FOUND", "Изменение для модерации не найдено.");
    return item;
  });

  app.get("/v1/partner/moderation", async (request) => {
    const { venueId } = await requirePartnerVenue(request.headers.authorization);
    return config.partnerCatalogRepository.listModeration({ status: "all", limit: 30, venueId });
  });

  app.get("/v1/partner/venue", async (request) => {
    const { venueId } = await requirePartnerVenue(request.headers.authorization);
    const venue = await config.partnerCatalogRepository.getVenue(venueId);
    if (!venue) throw new ApiError(404, "PARTNER_VENUE_NOT_FOUND", "Для этого кабинета площадка ещё не назначена.");
    return venue;
  });

  app.patch<{ Body: PartnerVenueWrite }>("/v1/partner/venue", {
    schema: { body: partnerVenueWriteSchema },
  }, async (request, reply) => {
    const { actorId, venueId } = await requirePartnerVenue(request.headers.authorization);
    const venue = await config.partnerCatalogRepository.updateVenue(venueId, actorId, validatePartnerVenueWrite(request.body));
    if (!venue) throw new ApiError(404, "PARTNER_VENUE_NOT_FOUND", "Площадка кабинета не найдена.");
    return reply.code(202).send(venue);
  });

  app.get("/v1/partner/rooms", async (request) => {
    const { venueId } = await requirePartnerVenue(request.headers.authorization);
    return config.partnerCatalogRepository.listRooms(venueId);
  });

  app.post<{ Body: PartnerRoomWrite }>("/v1/partner/rooms", {
    schema: { body: partnerRoomWriteSchema },
  }, async (request, reply) => {
    const { actorId, venueId } = await requirePartnerVenue(request.headers.authorization);
    const room = await config.partnerCatalogRepository.createRoom(venueId, actorId, validatePartnerRoomWrite(request.body));
    return reply.code(202).send(room);
  });

  app.patch<{ Params: PartnerRoomParams; Body: PartnerRoomWrite }>("/v1/partner/rooms/:roomId", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["roomId"],
        properties: { roomId: { type: "string", minLength: 36, maxLength: 36 } },
      },
      body: partnerRoomWriteSchema,
    },
  }, async (request) => {
    const { actorId, venueId } = await requirePartnerVenue(request.headers.authorization);
    const room = await config.partnerCatalogRepository.updateRoom(
      venueId,
      request.params.roomId,
      actorId,
      validatePartnerRoomWrite(request.body),
    );
    if (!room) throw new ApiError(404, "PARTNER_ROOM_NOT_FOUND", "Помещение не найдено в кабинете этой площадки.");
    return room;
  });

  app.put<{ Params: PartnerScheduleDateParams; Body: PartnerScheduleExceptionWrite }>("/v1/partner/schedule-exceptions/:date", {
    schema: { params: partnerScheduleDateParamsSchema, body: partnerScheduleExceptionWriteSchema },
  }, async (request) => {
    const { actorId, venueId } = await requirePartnerVenue(request.headers.authorization);
    if (!isIsoDate(request.params.date)) throw new ApiError(400, "INVALID_DATE", "Проверьте дату особого графика.");
    if (request.body.mode === "custom" && (
      request.body.opensAtHour === null
      || request.body.closesAtHour === null
      || request.body.closesAtHour <= request.body.opensAtHour
    )) {
      throw new ApiError(400, "INVALID_SCHEDULE_EXCEPTION", "Для особых часов закрытие должно быть позже открытия.");
    }
    const venue = await config.partnerCatalogRepository.setScheduleException(
      venueId,
      actorId,
      request.params.date,
      request.body,
    );
    if (!venue) throw new ApiError(404, "PARTNER_VENUE_NOT_FOUND", "Площадка кабинета не найдена.");
    return venue;
  });

  app.delete<{ Params: PartnerScheduleDateParams }>("/v1/partner/schedule-exceptions/:date", {
    schema: { params: partnerScheduleDateParamsSchema },
  }, async (request) => {
    const { actorId, venueId } = await requirePartnerVenue(request.headers.authorization);
    if (!isIsoDate(request.params.date)) throw new ApiError(400, "INVALID_DATE", "Проверьте дату особого графика.");
    const venue = await config.partnerCatalogRepository.deleteScheduleException(venueId, actorId, request.params.date);
    if (!venue) throw new ApiError(404, "PARTNER_VENUE_NOT_FOUND", "Площадка кабинета не найдена.");
    return venue;
  });

  app.get<{ Querystring: PartnerReservationQuery }>("/v1/partner/reservations", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          roomId: { type: "string", minLength: 36, maxLength: 36 },
          dateFrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          dateTo: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          includeCancelled: { type: "boolean" },
        },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    if (request.query.dateFrom && !isIsoDate(request.query.dateFrom)) throw new ApiError(400, "INVALID_DATE", "Проверьте начальную дату календаря.");
    if (request.query.dateTo && !isIsoDate(request.query.dateTo)) throw new ApiError(400, "INVALID_DATE", "Проверьте конечную дату календаря.");
    if (request.query.dateFrom && request.query.dateTo && request.query.dateFrom > request.query.dateTo) {
      throw new ApiError(400, "INVALID_DATE_RANGE", "Начальная дата не может быть позже конечной.");
    }
    return config.reservationRepository.listByPartner(current.user.id, request.query);
  });

  app.post<{ Body: PartnerReservationBody }>("/v1/partner/reservations", {
    schema: { body: partnerReservationBodySchema },
  }, async (request, reply) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const input = await validatePartnerReservation(current.user.id, request.body);
    return reply.code(201).send(await config.reservationRepository.create(current.user.id, input));
  });

  app.patch<{ Params: ReservationParams; Body: PartnerReservationBody }>("/v1/partner/reservations/:reservationId", {
    schema: { params: reservationParamsSchema, body: partnerReservationBodySchema },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const input = await validatePartnerReservation(current.user.id, request.body);
    const reservation = await config.reservationRepository.update(current.user.id, request.params.reservationId, input);
    if (!reservation) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Запись календаря не найдена.");
    return reservation;
  });

  app.post<{ Params: ReservationParams; Body: ReservationCancelBody }>("/v1/partner/reservations/:reservationId/cancel", {
    schema: {
      params: reservationParamsSchema,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: { reason: { type: "string", minLength: 3, maxLength: 1000 } },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const reservation = await config.reservationRepository.cancel(current.user.id, request.params.reservationId, request.body.reason.trim());
    if (!reservation) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Запись календаря не найдена.");
    return reservation;
  });

  app.post<{ Params: ReservationParams }>("/v1/partner/reservations/:reservationId/restore", {
    schema: { params: reservationParamsSchema },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const existing = await config.reservationRepository.findByPartner(current.user.id, request.params.reservationId);
    if (!existing) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Запись календаря не найдена.");
    await validatePartnerReservation(current.user.id, {
      roomId: existing.roomId,
      type: existing.type,
      ...(existing.category ? { category: existing.category } : {}),
      startsAt: existing.startsAt,
      endsAt: existing.endsAt,
      clientName: existing.clientName,
      clientPhone: existing.clientPhone,
      guests: existing.guests,
      amount: existing.amount,
      source: existing.source,
      comment: existing.comment,
    });
    const reservation = await config.reservationRepository.restore(current.user.id, request.params.reservationId);
    if (!reservation) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Запись календаря не найдена.");
    return reservation;
  });

  app.delete<{ Params: ReservationParams }>("/v1/partner/reservations/:reservationId", {
    schema: { params: reservationParamsSchema },
  }, async (request, reply) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const deleted = await config.reservationRepository.deleteTechnical(current.user.id, request.params.reservationId);
    if (!deleted) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Запись календаря не найдена.");
    return reply.code(204).send();
  });

  app.get<{ Querystring: PartnerBookingQuery }>("/v1/partner/bookings", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          statusGroup: { type: "string", enum: ["new", "payment", "booked", "history", "all"] },
        },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    return config.bookingRepository.listByPartner(current.user.id, request.query.statusGroup ?? "all");
  });

  app.post<{ Params: BookingParams; Body: PartnerBookingProposalBody }>("/v1/partner/bookings/:bookingId/proposal", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["startsAt", "durationMinutes"],
        properties: {
          startsAt: { type: "string", minLength: 20, maxLength: 40 },
          durationMinutes: { type: "integer", minimum: 30, maximum: 1440, multipleOf: 30 },
          comment: { type: "string", maxLength: 1000 },
        },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const input = await validateBookingProposal(current.user.id, request.params.bookingId, request.body);
    const booking = await config.bookingRepository.proposeTimeByPartner(current.user.id, request.params.bookingId, input);
    if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена в очереди этой площадки.");
    return booking;
  });

  app.post<{ Params: BookingParams }>("/v1/partner/bookings/:bookingId/confirm", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const booking = await config.bookingRepository.confirmByPartner(current.user.id, request.params.bookingId);
    if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена в очереди этой площадки.");
    return booking;
  });

  app.post<{ Params: BookingParams; Body: PartnerBookingRejectBody }>("/v1/partner/bookings/:bookingId/reject", {
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["bookingId"],
        properties: { bookingId: { type: "string", minLength: 36, maxLength: 36 } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: { reason: { type: "string", minLength: 5, maxLength: 1000 } },
      },
    },
  }, async (request) => {
    const current = await auth.authenticate(request.headers.authorization);
    if (!current || current.user.role !== "partner") throw new ApiError(401, "UNAUTHORIZED", "Войдите в кабинет партнёра.");
    const booking = await config.bookingRepository.rejectByPartner(current.user.id, request.params.bookingId, request.body.reason.trim());
    if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "Заявка не найдена в очереди этой площадки.");
    return booking;
  });

  app.get<{ Params: CityParams }>("/v1/cities/:cityId/stats", {
    schema: {
      params: {
        type: "object",
        required: ["cityId"],
        properties: { cityId: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  }, async (request) => {
    const stats = await config.repository.getCityStats(request.params.cityId);
    if (!stats) throw new ApiError(404, "CITY_NOT_FOUND", "Город не найден или ещё не поддерживается Rooms.");
    return stats;
  });

  app.get<{ Querystring: SearchQuery }>("/v1/rooms", {
    schema: {
      querystring: {
        type: "object",
        required: ["city"],
        additionalProperties: false,
        properties: {
          city: { type: "string", minLength: 1, maxLength: 100 },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
          durationMinutes: { type: "integer", minimum: 30, maximum: 1440, multipleOf: 30 },
          guests: { type: "integer", minimum: 1, maximum: 1000 },
          type: { type: "string", maxLength: 50 },
          features: { type: "string", maxLength: 500 },
          maxPricePerHour: { type: "number", minimum: 0 },
          sort: { type: "string", enum: ["rating", "price", "capacity"] },
        },
      },
    },
  }, async (request) => {
    const filters = normalizeFilters(request.query);
    const foundRooms = await config.repository.searchRooms(filters);
    const rooms = filters.date ? await withReservationBlocks(foundRooms, filters.date) : foundRooms;
    const availableRooms = filters.date
      ? rooms.filter((room) => {
          const windows = availabilityForRoom(room, filters.date!, filters.durationMinutes, filters.time);
          return filters.time ? windows.some((window) => window.exactMatch) : windows.length > 0;
        })
      : rooms;
    const items = await Promise.all(availableRooms.map((room) => presentRoom(
      config.repository,
      room,
      config.publicSiteUrl,
      filters.date,
      filters.durationMinutes,
      filters.time,
    )));
    return { items, nextCursor: null, hasMore: false };
  });

  app.get<{ Params: RoomParams }>("/v1/rooms/:roomId/reviews", {
    schema: {
      params: {
        type: "object",
        required: ["roomId"],
        properties: { roomId: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  }, async (request): Promise<PublicReviewPage> => {
    const reviews = await config.repository.listRoomReviews(request.params.roomId);
    if (!reviews) throw new ApiError(404, "ROOM_NOT_FOUND", "Помещение не найдено.");
    return { items: reviews, nextCursor: null, hasMore: false };
  });

  app.get<{ Params: RoomParams; Querystring: RoomQuery }>("/v1/rooms/:roomId", {
    schema: {
      params: {
        type: "object",
        required: ["roomId"],
        properties: { roomId: { type: "string", minLength: 1, maxLength: 100 } },
      },
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      },
    },
  }, async (request): Promise<PublicRoomDetail> => {
    const date = request.query.date ?? moscowToday();
    if (!isIsoDate(date)) throw new ApiError(400, "INVALID_DATE", "Дата должна существовать и иметь формат YYYY-MM-DD.");
    const foundRoom = await config.repository.findRoom(request.params.roomId, date);
    if (!foundRoom) throw new ApiError(404, "ROOM_NOT_FOUND", "Помещение не найдено.");
    const room = (await withReservationBlocks([foundRoom], date))[0]!;
    const summary = await presentRoom(config.repository, room, config.publicSiteUrl, date);
    return {
      ...summary,
      description: room.description,
      rules: room.rules,
      opensAtHour: room.opensAtHour,
      closesAtHour: room.closesAtHour,
      bufferMinutes: room.bufferMinutes,
      services: room.services,
      availability: {
        date,
        timezone: MOSCOW_TIMEZONE,
        windows: availabilityForRoom(room, date, room.minimumHours * 60),
      },
    };
  });

  app.post<{ Body: AvailabilityBody }>("/v1/availability/search", {
    schema: {
      body: {
        type: "object",
        required: ["roomIds", "date", "durationMinutes"],
        additionalProperties: false,
        properties: {
          roomIds: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          durationMinutes: { type: "integer", minimum: 30, maximum: 1440, multipleOf: 30 },
          preferredTime: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
          guests: { type: "integer", minimum: 1, maximum: 1000 },
        },
      },
    },
  }, async (request) => {
    const body = request.body;
    if (!isIsoDate(body.date)) throw new ApiError(400, "INVALID_DATE", "Дата должна существовать и иметь формат YYYY-MM-DD.");
    const found = await Promise.all(body.roomIds.map((id) => config.repository.findRoom(id, body.date)));
    const missing = body.roomIds.filter((_, index) => !found[index]);
    if (missing.length) throw new ApiError(404, "ROOM_NOT_FOUND", "Одно или несколько помещений не найдены.", missing);
    const rooms = await withReservationBlocks(found.filter((room): room is Room => room !== null), body.date);
    const capacityFits = !body.guests || rooms.every((room) => room.capacityMax >= body.guests!);
    const windows: AvailabilityWindow[] = capacityFits
      ? intersectAvailability(
          rooms.map((room) => availabilityForRoom(room, body.date, body.durationMinutes, body.preferredTime)),
          body.durationMinutes,
          body.preferredTime,
        )
      : [];
    return { date: body.date, timezone: MOSCOW_TIMEZONE, windows };
  });

  return app;
}
