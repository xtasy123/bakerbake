-- BakerBake POS Supabase schema
-- Run this in Supabase SQL Editor before setting SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

create table if not exists public.orders (
  id bigint primary key,
  customer_name text not null default 'Walk-in',
  cashier text not null default 'Unknown',
  status text not null default 'pending',
  total numeric(12, 2) not null default 0,
  payment_method text not null default 'cash',
  payment jsonb,
  items jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_payment_method_idx on public.orders (payment_method);

create table if not exists public.closeouts (
  id bigint primary key,
  expected_cash numeric(12, 2) not null default 0,
  actual_cash numeric(12, 2) not null default 0,
  difference numeric(12, 2) not null default 0,
  note text,
  cashier text not null default 'Unknown',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists closeouts_created_at_idx on public.closeouts (created_at desc);

create table if not exists public.app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_state (key, value)
values ('order_counter', '1001'::jsonb)
on conflict (key) do nothing;

insert into public.app_state (key, value)
values ('product_catalog', '[]'::jsonb)
on conflict (key) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.orders enable row level security;
alter table public.closeouts enable row level security;
alter table public.app_state enable row level security;

-- No public RLS policies are created here.
-- The local Node backend uses the service role key server-side, which bypasses RLS.
-- Do not expose SUPABASE_SERVICE_ROLE_KEY in browser code.
--
-- Existing installations must also run:
-- supabase/migrations/20260612_normalize_pos.sql
