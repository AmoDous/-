alter table fiscal_receipts
  add column if not exists processing_started_at timestamptz,
  add column if not exists provider_payload jsonb not null default '{}';

create index if not exists fiscal_receipts_stale_processing
  on fiscal_receipts (processing_started_at)
  where status = 'processing';
