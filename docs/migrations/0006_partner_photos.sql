alter table room_photos
  add column if not exists status room_status not null default 'published',
  add column if not exists storage_key uuid,
  add column if not exists original_name text,
  add column if not exists mime_type text,
  add column if not exists file_size_bytes bigint,
  add column if not exists created_by uuid references users(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists room_photos_storage_key_unique
  on room_photos(storage_key)
  where storage_key is not null;

create index if not exists room_photos_room_status_sort_idx
  on room_photos(room_id, status, is_cover desc, sort_order, created_at)
  where room_id is not null;

create index if not exists room_photos_venue_status_sort_idx
  on room_photos(venue_id, status, is_cover desc, sort_order, created_at)
  where venue_id is not null;

alter table room_photos
  drop constraint if exists room_photos_file_size_check;

alter table room_photos
  add constraint room_photos_file_size_check
  check (file_size_bytes is null or file_size_bytes between 1 and 12582912);
