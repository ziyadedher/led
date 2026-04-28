-- The original notify_panel_change function references (new).panel_id
-- and (new).id from inside a single CASE/WHEN, but Postgres validates
-- column references against the row type before deciding which branch
-- runs — so the function fails with "column panel_id not found" when
-- fired by the panels trigger. Split into per-table functions.

drop trigger if exists entries_notify on public.entries;
drop trigger if exists panels_notify on public.panels;
drop function if exists public.notify_panel_change();

create or replace function public.notify_panel_change_from_entry() returns trigger
    language plpgsql
    as $$
declare
    target_panel_id text;
begin
    target_panel_id := coalesce(new.panel_id, old.panel_id)::text;
    if target_panel_id is not null then
        perform pg_notify('panel_change', target_panel_id);
    end if;
    return null;
end;
$$;

create or replace function public.notify_panel_change_from_panel() returns trigger
    language plpgsql
    as $$
declare
    target_panel_id text;
begin
    target_panel_id := coalesce(new.id, old.id)::text;
    if target_panel_id is not null then
        perform pg_notify('panel_change', target_panel_id);
    end if;
    return null;
end;
$$;

create trigger entries_notify
    after insert or update or delete on public.entries
    for each row execute function public.notify_panel_change_from_entry();

create trigger panels_notify
    after update on public.panels
    for each row execute function public.notify_panel_change_from_panel();
