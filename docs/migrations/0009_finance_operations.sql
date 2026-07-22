alter table venue_bank_accounts
  add column if not exists account_last_four char(4),
  add column if not exists updated_by uuid references users(id) on delete set null;

alter table payout_batches
  add column if not exists provider_payout_id text,
  add column if not exists failure_reason text,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists refunds_payment_unique
  on refunds (payment_id);

create unique index if not exists payout_batches_provider_unique
  on payout_batches (provider_payout_id)
  where provider_payout_id is not null;

create index if not exists refunds_status_queue
  on refunds (status, created_at);

create index if not exists payout_batches_status_queue
  on payout_batches (status, scheduled_for, created_at);

create index if not exists payout_batches_venue_history
  on payout_batches (venue_id, created_at desc);

update bookings
set partner_amount = greatest(0, prepayment - commission),
    updated_at = now()
where partner_amount <> greatest(0, prepayment - commission);

update booking_time_proposals
set partner_amount = greatest(0, prepayment - commission)
where partner_amount <> greatest(0, prepayment - commission);
