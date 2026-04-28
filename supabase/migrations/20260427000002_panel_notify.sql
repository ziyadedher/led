-- Postgres LISTEN/NOTIFY plumbing so the Pi driver can switch from
-- polling to push. Triggers on `entries` and `panels` emit a
-- `panel_change` notification carrying the affected panel id; the
-- driver subscribes via `LISTEN panel_change` and re-pulls state on
-- match. Polling stays as a fallback for missed notifications.

create or replace function public.notify_panel_change() returns trigger
    language plpgsql
    as $$
declare
    target_panel_id text;
begin
    target_panel_id := coalesce(
        case when tg_table_name = 'entries' then
            coalesce((new).panel_id, (old).panel_id)::text
        end,
        case when tg_table_name = 'panels' then
            coalesce((new).id, (old).id)::text
        end
    );
    if target_panel_id is not null then
        perform pg_notify('panel_change', target_panel_id);
    end if;
    return null;
end;
$$;

drop trigger if exists entries_notify on public.entries;
create trigger entries_notify
    after insert or update or delete on public.entries
    for each row execute function public.notify_panel_change();

drop trigger if exists panels_notify on public.panels;
create trigger panels_notify
    after update on public.panels
    for each row execute function public.notify_panel_change();
