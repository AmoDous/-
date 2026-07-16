alter table user_sessions
  add column if not exists last_seen_at timestamptz;

update user_sessions
set last_seen_at = created_at
where last_seen_at is null;

alter table user_sessions
  alter column last_seen_at set default now(),
  alter column last_seen_at set not null;

create index if not exists user_sessions_active_user_idx
  on user_sessions (user_id, last_seen_at desc)
  where revoked_at is null;

create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash char(64) not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  requested_ip inet,
  requested_user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_tokens_active_user_idx
  on password_reset_tokens (user_id, created_at desc)
  where consumed_at is null;
