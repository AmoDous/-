create table if not exists booking_support_cases (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  opened_by uuid references users(id) on delete set null,
  opened_by_role user_role not null,
  topic text not null,
  status text not null default 'open',
  assigned_to uuid references users(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_support_status check (status in ('open', 'working', 'closed'))
);

create unique index if not exists booking_support_one_active
  on booking_support_cases (booking_id)
  where status <> 'closed';

create index if not exists booking_support_queue
  on booking_support_cases (status, updated_at desc);

create table if not exists booking_support_messages (
  id uuid primary key default gen_random_uuid(),
  support_case_id uuid not null references booking_support_cases(id) on delete cascade,
  sender_id uuid references users(id) on delete set null,
  sender_role user_role not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists booking_support_messages_timeline
  on booking_support_messages (support_case_id, created_at);
