alter table refunds
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists processing_started_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists last_error text,
  add column if not exists provider_payload jsonb not null default '{}',
  add column if not exists updated_at timestamptz not null default now();

alter table refunds
  add constraint refunds_attempts_nonnegative check (attempts >= 0);

create index if not exists refunds_automatic_queue
  on refunds (status, next_attempt_at, created_at)
  where status in ('refund_pending', 'failed');

create index if not exists refunds_stale_processing
  on refunds (processing_started_at)
  where status = 'refund_pending' and processing_started_at is not null;
