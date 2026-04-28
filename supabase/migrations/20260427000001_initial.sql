-- Initial schema for the LED v1 project.
-- Two tables, both anon-accessible via permissive RLS for now (v2 will tighten
-- to per-panel auth tokens). Both publish to supabase_realtime so the dash gets
-- push updates instead of polling.

create extension if not exists "pgcrypto";

create table if not exists public.panels (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    name text not null unique,
    description text not null default '',
    scroll integer not null default 0,
    is_paused boolean not null default false,
    last_updated timestamptz not null default now(),
    flash jsonb not null default '{"is_active": false, "on_steps": 0, "total_steps": 0}'::jsonb
);

create table if not exists public.entries (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    panel_id uuid not null references public.panels(id) on delete cascade,
    "order" integer not null default 0,
    data jsonb not null
);

create index if not exists entries_panel_id_order_idx
    on public.entries(panel_id, "order");

-- Realtime publication. Wrapped in a DO block so re-running the
-- migration on a project where the tables are already members of
-- supabase_realtime is a no-op (the bare `alter publication ... add
-- table` form errors with SQLSTATE 42710 on duplicate).
do $$
begin
    alter publication supabase_realtime add table public.panels;
exception when duplicate_object then null;
end $$;

do $$
begin
    alter publication supabase_realtime add table public.entries;
exception when duplicate_object then null;
end $$;

-- Permissive RLS: any holder of the anon JWT can read/write. v1 only.
alter table public.panels enable row level security;
alter table public.entries enable row level security;

drop policy if exists "anon all on panels" on public.panels;
create policy "anon all on panels" on public.panels for all to anon
    using (true) with check (true);

drop policy if exists "anon all on entries" on public.entries;
create policy "anon all on entries" on public.entries for all to anon
    using (true) with check (true);
