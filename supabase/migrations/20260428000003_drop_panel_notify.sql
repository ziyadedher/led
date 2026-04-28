-- Drop the bespoke panel_change LISTEN/NOTIFY plumbing. The driver now
-- subscribes to postgres_changes via the Supabase Realtime WebSocket
-- (which uses the public *.supabase.co cert and rides on the
-- supabase_realtime publication that already covers panels + entries),
-- so the custom triggers and function are dead weight.

drop trigger if exists entries_notify on public.entries;
drop trigger if exists panels_notify on public.panels;
drop function if exists public.notify_panel_change_from_entry();
drop function if exists public.notify_panel_change_from_panel();
drop function if exists public.notify_panel_change();
