-- Driver liveness ping. Each Pi writes panels.last_seen on every
-- heartbeat (every 30s). The dash uses this to flag panels that
-- haven't checked in recently as offline — independent of
-- last_updated, which only moves when the panel's data changes.

alter table public.panels
    add column if not exists last_seen timestamptz not null default now();
