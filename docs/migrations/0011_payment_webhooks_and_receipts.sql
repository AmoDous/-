create table if not exists payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_key text not null,
  provider_payment_id text not null,
  operation text not null,
  payload jsonb not null default '{}',
  status text not null default 'processed',
  outcome text not null,
  payment_id uuid references payment_transactions(id) on delete set null,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint payment_webhook_events_status check (status in ('processed','ignored','failed')),
  unique (provider, event_key)
);

create index if not exists payment_webhook_provider_payment
  on payment_webhook_events (provider, provider_payment_id, created_at desc);

create table if not exists fiscal_receipts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payment_transactions(id) on delete cascade,
  booking_id uuid not null references bookings(id) on delete cascade,
  receipt_type text not null,
  status text not null default 'queued',
  amount numeric(12,2) not null,
  currency char(3) not null default 'RUB',
  provider text,
  provider_receipt_id text,
  fiscal_document_number text,
  fiscal_sign text,
  receipt_url text,
  items jsonb not null default '[]',
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_receipts_type check (receipt_type in ('sale','refund')),
  constraint fiscal_receipts_status check (status in ('queued','processing','succeeded','failed','cancelled')),
  constraint fiscal_receipts_amount_positive check (amount > 0),
  unique (payment_id, receipt_type)
);

create unique index if not exists fiscal_receipts_provider_unique
  on fiscal_receipts (provider, provider_receipt_id)
  where provider_receipt_id is not null;

create index if not exists fiscal_receipts_queue
  on fiscal_receipts (status, next_attempt_at, created_at);

create index if not exists fiscal_receipts_booking_history
  on fiscal_receipts (booking_id, created_at desc);

create trigger fiscal_receipts_updated_at
before update on fiscal_receipts
for each row execute function set_updated_at();
