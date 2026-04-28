-- Multi-mode foundation. Each panel selects a render mode (text,
-- clock, image, …); the driver dispatches to a per-mode renderer.
-- mode_config carries per-mode settings (e.g. clock format, weather
-- location) so we don't need a separate table per mode.

alter table public.panels
    add column if not exists mode text not null default 'text',
    add column if not exists mode_config jsonb not null default '{}'::jsonb;
