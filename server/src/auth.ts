import { argon2, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export type UserRole = "client" | "partner" | "admin" | "accountant";

export interface PublicUser {
  id: string;
  role: UserRole;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  passwordResetRequired: boolean;
}

export interface AuthUser extends PublicUser {
  passwordHash: string | null;
  blockedAt: string | null;
}

export interface LegalAcceptance {
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: string;
}

export interface ClientRegistrationInput {
  name: string;
  email: string;
  phone: string;
  city: string;
  passwordHash: string;
  legal: LegalAcceptance;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface PublicAuthSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface PasswordResetRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ClientProfileUpdate {
  name: string;
  email: string;
  phone: string;
  city: string;
  passwordHash?: string;
}

export interface AuthRepository {
  readonly storage: "memory" | "postgresql";
  createClient(input: ClientRegistrationInput): Promise<AuthUser>;
  findUserByLogin(login: string, normalizedPhone: string | null): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  updateClientProfile(id: string, input: ClientProfileUpdate): Promise<AuthUser | null>;
  touchUser(id: string): Promise<void>;
  createSession(input: AuthSessionRecord): Promise<void>;
  findSession(id: string): Promise<AuthSessionRecord | null>;
  consumeSession(id: string, refreshTokenHash: string): Promise<AuthSessionRecord | null>;
  touchSession(id: string): Promise<void>;
  listSessions(userId: string): Promise<AuthSessionRecord[]>;
  revokeSession(id: string): Promise<void>;
  revokeSessionForUser(userId: string, sessionId: string): Promise<boolean>;
  revokeOtherSessions(userId: string, exceptSessionId: string): Promise<void>;
  createPasswordReset(input: PasswordResetRecord): Promise<void>;
  completePasswordReset(tokenHash: string, passwordHash: string, completedAt: string): Promise<boolean>;
}

export class AuthConflictError extends Error {
  constructor() {
    super("A user with this email or phone already exists.");
  }
}

interface UserRow extends QueryResultRow {
  id: string;
  role: UserRole;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  password_hash: string | null;
  password_reset_required: boolean;
  blocked_at: Date | string | null;
}

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  user_agent: string | null;
  ip: string | null;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function userFromRow(row: UserRow): AuthUser {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    passwordHash: row.password_hash,
    passwordResetRequired: row.password_reset_required,
    blockedAt: iso(row.blocked_at),
  };
}

function sessionFromRow(row: SessionRow): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    refreshTokenHash: row.refresh_token_hash,
    userAgent: row.user_agent,
    ip: row.ip,
    expiresAt: iso(row.expires_at)!,
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at)!,
    lastSeenAt: iso(row.last_seen_at)!,
  };
}

export class MemoryAuthRepository implements AuthRepository {
  readonly storage = "memory" as const;
  private readonly users = new Map<string, AuthUser>();
  private readonly sessions = new Map<string, AuthSessionRecord>();
  private readonly passwordResets = new Map<string, PasswordResetRecord>();

  constructor(initialUsers: AuthUser[] = []) {
    for (const user of initialUsers) this.users.set(user.id, structuredClone(user));
  }

  async createClient(input: ClientRegistrationInput): Promise<AuthUser> {
    const duplicate = [...this.users.values()].some((user) => (
      user.email?.toLocaleLowerCase("ru-RU") === input.email.toLocaleLowerCase("ru-RU") || user.phone === input.phone
    ));
    if (duplicate) throw new AuthConflictError();
    const user: AuthUser = {
      id: randomUUID(),
      role: "client",
      name: input.name,
      email: input.email,
      phone: input.phone,
      city: input.city,
      passwordHash: input.passwordHash,
      passwordResetRequired: false,
      blockedAt: null,
    };
    this.users.set(user.id, user);
    return structuredClone(user);
  }

  async findUserByLogin(login: string, normalizedPhone: string | null): Promise<AuthUser | null> {
    const normalizedLogin = login.trim().toLocaleLowerCase("ru-RU");
    const found = [...this.users.values()].find((user) => (
      user.email?.toLocaleLowerCase("ru-RU") === normalizedLogin || (normalizedPhone !== null && user.phone === normalizedPhone)
    ));
    return found ? structuredClone(found) : null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const found = this.users.get(id);
    return found ? structuredClone(found) : null;
  }

  async updateClientProfile(id: string, input: ClientProfileUpdate): Promise<AuthUser | null> {
    const current = this.users.get(id);
    if (!current || current.role !== "client") return null;
    const duplicate = [...this.users.values()].some((user) => user.id !== id && (
      user.email?.toLocaleLowerCase("ru-RU") === input.email.toLocaleLowerCase("ru-RU") || user.phone === input.phone
    ));
    if (duplicate) throw new AuthConflictError();
    const updated: AuthUser = {
      ...current,
      name: input.name,
      email: input.email,
      phone: input.phone,
      city: input.city,
      passwordHash: input.passwordHash ?? current.passwordHash,
      passwordResetRequired: input.passwordHash ? false : current.passwordResetRequired,
    };
    this.users.set(id, updated);
    return structuredClone(updated);
  }

  async touchUser(_id: string): Promise<void> {}

  async createSession(input: AuthSessionRecord): Promise<void> {
    this.sessions.set(input.id, structuredClone(input));
  }

  async findSession(id: string): Promise<AuthSessionRecord | null> {
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : null;
  }

  async consumeSession(id: string, refreshTokenHash: string): Promise<AuthSessionRecord | null> {
    const found = this.sessions.get(id);
    if (!found || found.refreshTokenHash !== refreshTokenHash || found.revokedAt !== null || new Date(found.expiresAt).getTime() <= Date.now()) return null;
    this.sessions.set(id, { ...found, revokedAt: new Date().toISOString() });
    return structuredClone(found);
  }

  async touchSession(id: string): Promise<void> {
    const found = this.sessions.get(id);
    if (found) this.sessions.set(id, { ...found, lastSeenAt: new Date().toISOString() });
  }

  async listSessions(userId: string): Promise<AuthSessionRecord[]> {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId && session.revokedAt === null && new Date(session.expiresAt).getTime() > now)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map((session) => structuredClone(session));
  }

  async revokeSession(id: string): Promise<void> {
    const found = this.sessions.get(id);
    if (found) this.sessions.set(id, { ...found, revokedAt: new Date().toISOString() });
  }

  async revokeSessionForUser(userId: string, sessionId: string): Promise<boolean> {
    const found = this.sessions.get(sessionId);
    if (!found || found.userId !== userId || found.revokedAt !== null) return false;
    this.sessions.set(sessionId, { ...found, revokedAt: new Date().toISOString() });
    return true;
  }

  async revokeOtherSessions(userId: string, exceptSessionId: string): Promise<void> {
    const revokedAt = new Date().toISOString();
    for (const [id, session] of this.sessions) {
      if (session.userId === userId && id !== exceptSessionId && session.revokedAt === null) this.sessions.set(id, { ...session, revokedAt });
    }
  }

  async createPasswordReset(input: PasswordResetRecord): Promise<void> {
    const consumedAt = new Date().toISOString();
    for (const [hash, reset] of this.passwordResets) {
      if (reset.userId === input.userId && reset.consumedAt === null) this.passwordResets.set(hash, { ...reset, consumedAt });
      if (new Date(reset.expiresAt).getTime() < Date.now() - 7 * 86_400_000) this.passwordResets.delete(hash);
    }
    this.passwordResets.set(input.tokenHash, structuredClone(input));
  }

  async completePasswordReset(tokenHash: string, passwordHash: string, completedAt: string): Promise<boolean> {
    const reset = this.passwordResets.get(tokenHash);
    if (!reset || reset.consumedAt !== null || new Date(reset.expiresAt).getTime() <= Date.now()) return false;
    const user = this.users.get(reset.userId);
    if (!user || user.blockedAt !== null) return false;
    this.users.set(user.id, { ...user, passwordHash, passwordResetRequired: false });
    for (const [hash, item] of this.passwordResets) {
      if (item.userId === user.id && item.consumedAt === null) this.passwordResets.set(hash, { ...item, consumedAt: completedAt });
    }
    for (const [id, session] of this.sessions) {
      if (session.userId === user.id && session.revokedAt === null) this.sessions.set(id, { ...session, revokedAt: completedAt });
    }
    return true;
  }
}

export class PostgresAuthRepository implements AuthRepository {
  readonly storage = "postgresql" as const;

  constructor(private readonly pool: Pool) {}

  async createClient(input: ClientRegistrationInput): Promise<AuthUser> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<UserRow>(`/* rooms:auth-create-client */
        insert into users (role, name, email, phone, city, password_hash)
        values ('client', $1, $2, $3, $4, $5)
        returning id::text, role, name, email::text, phone, city, password_hash,
          password_reset_required, blocked_at
      `, [input.name, input.email, input.phone, input.city, input.passwordHash]);
      const user = result.rows[0];
      if (!user) throw new Error("PostgreSQL did not return the created Rooms user.");
      await this.insertConsent(client, user.id, input);
      await client.query("commit");
      return userFromRow(user);
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") throw new AuthConflictError();
      throw error;
    } finally {
      client.release();
    }
  }

  async findUserByLogin(login: string, normalizedPhone: string | null): Promise<AuthUser | null> {
    const result = await this.pool.query<UserRow>(`/* rooms:auth-find-login */
      select id::text, role, name, email::text, phone, city, password_hash,
        password_reset_required, blocked_at
      from users
      where email = $1 or ($2::text is not null and phone = $2)
      limit 1
    `, [login.trim().toLocaleLowerCase("ru-RU"), normalizedPhone]);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const result = await this.pool.query<UserRow>(`/* rooms:auth-find-user */
      select id::text, role, name, email::text, phone, city, password_hash,
        password_reset_required, blocked_at
      from users
      where id = $1::uuid
      limit 1
    `, [id]);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async updateClientProfile(id: string, input: ClientProfileUpdate): Promise<AuthUser | null> {
    try {
      const result = await this.pool.query<UserRow>(`/* rooms:auth-update-client */
        update users
        set name = $2, email = $3, phone = $4, city = $5,
          password_hash = coalesce($6, password_hash),
          password_reset_required = case when $6::text is null then password_reset_required else false end,
          last_active_at = now(), updated_at = now()
        where id = $1::uuid and role = 'client'
        returning id::text, role, name, email::text, phone, city, password_hash,
          password_reset_required, blocked_at
      `, [id, input.name, input.email, input.phone, input.city, input.passwordHash ?? null]);
      return result.rows[0] ? userFromRow(result.rows[0]) : null;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AuthConflictError();
      throw error;
    }
  }

  async touchUser(id: string): Promise<void> {
    await this.pool.query("update users set last_active_at = now(), updated_at = now() where id = $1::uuid", [id]);
  }

  async createSession(input: AuthSessionRecord & { ip: string | null; userAgent: string | null }): Promise<void> {
    await this.pool.query(`/* rooms:auth-create-session */
      insert into user_sessions (id, user_id, refresh_token_hash, user_agent, ip, expires_at)
      values ($1::uuid, $2::uuid, $3, $4, $5::inet, $6::timestamptz)
    `, [input.id, input.userId, input.refreshTokenHash, input.userAgent, input.ip, input.expiresAt]);
    await this.pool.query("delete from user_sessions where expires_at < now() - interval '7 days'", []);
  }

  async findSession(id: string): Promise<AuthSessionRecord | null> {
    const result = await this.pool.query<SessionRow>(`/* rooms:auth-find-session */
      select id::text, user_id::text, refresh_token_hash, user_agent, host(ip)::text as ip,
        expires_at, revoked_at, created_at, last_seen_at
      from user_sessions
      where id = $1::uuid
      limit 1
    `, [id]);
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  async consumeSession(id: string, refreshTokenHash: string): Promise<AuthSessionRecord | null> {
    const result = await this.pool.query<SessionRow>(`/* rooms:auth-consume-session */
      update user_sessions
      set revoked_at = now(), last_seen_at = now()
      where id = $1::uuid
        and refresh_token_hash = $2
        and revoked_at is null
        and expires_at > now()
      returning id::text, user_id::text, refresh_token_hash, user_agent, host(ip)::text as ip,
        expires_at, null::timestamptz as revoked_at, created_at, last_seen_at
    `, [id, refreshTokenHash]);
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  async touchSession(id: string): Promise<void> {
    await this.pool.query(`
      update user_sessions set last_seen_at = now()
      where id = $1::uuid and revoked_at is null and last_seen_at < now() - interval '5 minutes'
    `, [id]);
  }

  async listSessions(userId: string): Promise<AuthSessionRecord[]> {
    const result = await this.pool.query<SessionRow>(`/* rooms:auth-list-sessions */
      select id::text, user_id::text, refresh_token_hash, user_agent, host(ip)::text as ip,
        expires_at, revoked_at, created_at, last_seen_at
      from user_sessions
      where user_id = $1::uuid and revoked_at is null and expires_at > now()
      order by last_seen_at desc, created_at desc
    `, [userId]);
    return result.rows.map(sessionFromRow);
  }

  async revokeSession(id: string): Promise<void> {
    await this.pool.query("update user_sessions set revoked_at = coalesce(revoked_at, now()) where id = $1::uuid", [id]);
  }

  async revokeSessionForUser(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query(`
      update user_sessions set revoked_at = coalesce(revoked_at, now())
      where user_id = $1::uuid and id = $2::uuid and revoked_at is null
      returning id
    `, [userId, sessionId]);
    return (result.rowCount ?? 0) > 0;
  }

  async revokeOtherSessions(userId: string, exceptSessionId: string): Promise<void> {
    await this.pool.query(`
      update user_sessions
      set revoked_at = coalesce(revoked_at, now())
      where user_id = $1::uuid and id <> $2::uuid and revoked_at is null
    `, [userId, exceptSessionId]);
  }

  async createPasswordReset(input: PasswordResetRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`
        update password_reset_tokens set consumed_at = coalesce(consumed_at, now())
        where user_id = $1::uuid and consumed_at is null
      `, [input.userId]);
      await client.query(`/* rooms:auth-create-password-reset */
        insert into password_reset_tokens (
          id, user_id, token_hash, expires_at, requested_ip, requested_user_agent, created_at
        ) values ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::inet, $6, $7::timestamptz)
      `, [input.id, input.userId, input.tokenHash, input.expiresAt, input.ip, input.userAgent, input.createdAt]);
      await client.query("delete from password_reset_tokens where expires_at < now() - interval '7 days'");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async completePasswordReset(tokenHash: string, passwordHash: string, completedAt: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const reset = await client.query<{ user_id: string }>(`/* rooms:auth-complete-password-reset */
        update password_reset_tokens
        set consumed_at = $2::timestamptz
        where id = (
          select id from password_reset_tokens
          where token_hash = $1 and consumed_at is null and expires_at > $2::timestamptz
          order by created_at desc limit 1 for update
        )
        returning user_id::text
      `, [tokenHash, completedAt]);
      const userId = reset.rows[0]?.user_id;
      if (!userId) {
        await client.query("rollback");
        return false;
      }
      const updated = await client.query(`
        update users
        set password_hash = $2, password_reset_required = false, updated_at = $3::timestamptz
        where id = $1::uuid and blocked_at is null
        returning id
      `, [userId, passwordHash, completedAt]);
      if ((updated.rowCount ?? 0) === 0) {
        await client.query("rollback");
        return false;
      }
      await client.query(`
        update password_reset_tokens set consumed_at = coalesce(consumed_at, $2::timestamptz)
        where user_id = $1::uuid
      `, [userId, completedAt]);
      await client.query(`
        update user_sessions set revoked_at = coalesce(revoked_at, $2::timestamptz)
        where user_id = $1::uuid
      `, [userId, completedAt]);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertConsent(client: PoolClient, userId: string, input: ClientRegistrationInput): Promise<void> {
    const version = input.legal.termsVersion === input.legal.privacyVersion
      ? input.legal.termsVersion
      : `terms:${input.legal.termsVersion};privacy:${input.legal.privacyVersion}`;
    await client.query(`/* rooms:auth-create-consent */
      insert into personal_data_consents (
        user_id, subject_phone, subject_email, context, documents, document_version,
        ip, user_agent, accepted_at
      ) values ($1::uuid, $2, $3, 'registration', array['terms','privacy'], $4, $5::inet, $6, $7::timestamptz)
    `, [userId, input.phone, input.email, version, input.ip, input.userAgent, input.legal.acceptedAt]);
  }
}

interface PasswordParameters {
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
}

const passwordParameters: PasswordParameters = { parallelism: 1, tagLength: 32, memory: 65_536, passes: 3 };
const accessTokenLifetimeSeconds = 15 * 60;
const refreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;
export const passwordResetLifetimeSeconds = 15 * 60;

function derivePassword(password: string, salt: Buffer, parameters: PasswordParameters = passwordParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, ...parameters }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function base64(value: Buffer): string {
  return value.toString("base64").replace(/=+$/u, "");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `$argon2id$v=19$m=${passwordParameters.memory},t=${passwordParameters.passes},p=${passwordParameters.parallelism}$${base64(salt)}$${base64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/u.exec(encoded);
  if (!match) return false;
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  if (memory < 8 || memory > 262_144 || passes < 1 || passes > 10 || parallelism < 1 || parallelism > 16) return false;
  const expected = Buffer.from(match[5]!, "base64");
  const actual = await derivePassword(password, Buffer.from(match[4]!, "base64"), {
    memory,
    passes,
    parallelism,
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeRussianPhone(value: string): string | null {
  let digits = value.replace(/\D/gu, "");
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  return digits.length === 11 && digits.startsWith("7") ? `+${digits}` : null;
}

function publicUser(user: AuthUser): PublicUser {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    phone: user.phone,
    city: user.city,
    passwordResetRequired: user.passwordResetRequired,
  };
}

interface AccessPayload {
  sub: string;
  sid: string;
  role: UserRole;
  iat: number;
  exp: number;
}

export interface IssuedAuthSession {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

export interface AuthenticatedUser {
  user: PublicUser;
  sessionId: string;
}

export interface ClientProfileChange {
  name: string;
  email: string;
  phone: string;
  city: string;
  currentPassword?: string;
  newPassword?: string;
}

export class AuthService {
  private readonly dummyPasswordHash: Promise<string>;

  constructor(private readonly repository: AuthRepository, private readonly tokenSecret: string) {
    if (Buffer.byteLength(tokenSecret, "utf8") < 32) throw new Error("AUTH_TOKEN_SECRET must contain at least 32 bytes.");
    this.dummyPasswordHash = hashPassword(randomBytes(32).toString("base64url"));
  }

  async register(input: Omit<ClientRegistrationInput, "passwordHash"> & { password: string }): Promise<IssuedAuthSession> {
    const passwordHash = await hashPassword(input.password);
    const user = await this.repository.createClient({ ...input, passwordHash });
    return this.issueSession(user, input.ip, input.userAgent);
  }

  async login(login: string, password: string, ip: string | null, userAgent: string | null): Promise<IssuedAuthSession | null> {
    const user = await this.repository.findUserByLogin(login, normalizeRussianPhone(login));
    const passwordHash = user?.passwordHash ?? await this.dummyPasswordHash;
    const passwordMatches = await verifyPassword(password, passwordHash);
    if (!user || !passwordMatches || user.blockedAt !== null) return null;
    await this.repository.touchUser(user.id);
    return this.issueSession(user, ip, userAgent);
  }

  async refresh(refreshToken: string, ip: string | null, userAgent: string | null): Promise<IssuedAuthSession | null> {
    const parsed = this.parseRefreshToken(refreshToken);
    if (!parsed) return null;
    const refreshTokenHash = createHash("sha256").update(refreshToken).digest("hex");
    const session = await this.repository.consumeSession(parsed.sessionId, refreshTokenHash);
    if (!session) return null;
    const user = await this.repository.findUserById(session.userId);
    if (!user || user.blockedAt !== null) return null;
    return this.issueSession(user, ip, userAgent);
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedUser | null> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const payload = this.verifyAccessToken(token);
    if (!payload) return null;
    const session = await this.repository.findSession(payload.sid);
    if (!session || session.userId !== payload.sub || !this.sessionActive(session)) return null;
    const user = await this.repository.findUserById(payload.sub);
    if (!user || user.blockedAt !== null || user.role !== payload.role) return null;
    await this.repository.touchSession(session.id);
    return { user: publicUser(user), sessionId: session.id };
  }

  async requestPasswordReset(login: string, ip: string | null, userAgent: string | null): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const user = await this.repository.findUserByLogin(login, normalizeRussianPhone(login));
    if (user && user.blockedAt === null && user.passwordHash) {
      const createdAt = new Date().toISOString();
      await this.repository.createPasswordReset({
        id: randomUUID(),
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + passwordResetLifetimeSeconds * 1000).toISOString(),
        consumedAt: null,
        ip,
        userAgent,
        createdAt,
      });
    }
    return token;
  }

  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const passwordHash = await hashPassword(newPassword);
    return this.repository.completePasswordReset(tokenHash, passwordHash, new Date().toISOString());
  }

  async listSessions(userId: string, currentSessionId: string): Promise<PublicAuthSession[]> {
    const sessions = await this.repository.listSessions(userId);
    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ip: session.ip,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      current: session.id === currentSessionId,
    }));
  }

  revokeUserSession(userId: string, sessionId: string): Promise<boolean> {
    return this.repository.revokeSessionForUser(userId, sessionId);
  }

  revokeOtherUserSessions(userId: string, currentSessionId: string): Promise<void> {
    return this.repository.revokeOtherSessions(userId, currentSessionId);
  }

  async updateClientProfile(userId: string, sessionId: string, input: ClientProfileChange): Promise<PublicUser | null> {
    const current = await this.repository.findUserById(userId);
    if (!current || current.role !== "client" || current.blockedAt !== null) return null;
    let passwordHash: string | undefined;
    if (input.newPassword) {
      if (!input.currentPassword || !current.passwordHash || !await verifyPassword(input.currentPassword, current.passwordHash)) return null;
      passwordHash = await hashPassword(input.newPassword);
    }
    const update: ClientProfileUpdate = { name: input.name, email: input.email, phone: input.phone, city: input.city };
    if (passwordHash) update.passwordHash = passwordHash;
    const updated = await this.repository.updateClientProfile(userId, update);
    if (updated && passwordHash) await this.repository.revokeOtherSessions(userId, sessionId);
    return updated ? publicUser(updated) : null;
  }

  async logout(authorization: string | undefined, refreshToken: string | null): Promise<void> {
    const accessToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const payload = this.verifyAccessToken(accessToken, true);
    const parsedRefresh = refreshToken ? this.parseRefreshToken(refreshToken) : null;
    const sessionIds = [...new Set([payload?.sid, parsedRefresh?.sessionId].filter((id): id is string => Boolean(id)))];
    await Promise.all(sessionIds.map((sessionId) => this.repository.revokeSession(sessionId)));
  }

  private async issueSession(user: AuthUser, ip: string | null, userAgent: string | null): Promise<IssuedAuthSession> {
    const sessionId = randomUUID();
    const refreshToken = `${sessionId}.${randomBytes(32).toString("base64url")}`;
    const refreshTokenHash = createHash("sha256").update(refreshToken).digest("hex");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + refreshTokenLifetimeSeconds * 1000).toISOString();
    await this.repository.createSession({
      id: sessionId,
      userId: user.id,
      refreshTokenHash,
      expiresAt,
      revokedAt: null,
      ip,
      userAgent,
      createdAt,
      lastSeenAt: createdAt,
    });
    return {
      user: publicUser(user),
      accessToken: this.signAccessToken(user, sessionId),
      expiresIn: accessTokenLifetimeSeconds,
      refreshToken,
      refreshExpiresIn: refreshTokenLifetimeSeconds,
    };
  }

  private signAccessToken(user: AuthUser, sessionId: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: user.id, sid: sessionId, role: user.role, iat: now, exp: now + accessTokenLifetimeSeconds })).toString("base64url");
    const body = `${header}.${payload}`;
    const signature = createHmac("sha256", this.tokenSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verifyAccessToken(token: string, allowExpired = false): AccessPayload | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const expected = createHmac("sha256", this.tokenSecret).update(body).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(parts[2]!, "base64url");
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as AccessPayload;
      const roles: UserRole[] = ["client", "partner", "admin", "accountant"];
      const now = Math.floor(Date.now() / 1000);
      if (!payload.sub || !payload.sid || !roles.includes(payload.role) || !Number.isInteger(payload.exp)) return null;
      if (!allowExpired && payload.exp <= now) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private parseRefreshToken(token: string): { sessionId: string } | null {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32,})$/iu.exec(token);
    return match ? { sessionId: match[1]! } : null;
  }

  private sessionActive(session: AuthSessionRecord): boolean {
    return session.revokedAt === null && new Date(session.expiresAt).getTime() > Date.now();
  }

}
