alter table reviews
  add column if not exists moderation_comment text,
  add column if not exists moderated_by uuid references users(id) on delete set null,
  add column if not exists moderated_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists reviews_client_idx on reviews(client_id, updated_at desc);
create index if not exists reviews_moderation_idx on reviews(status, updated_at desc);
