-- Driver version reporting. Each Pi writes its build sha to
-- panels.driver_version at startup; the dash uses it to flag panels
-- running an older binary than the rest of the fleet.
alter table public.panels
    add column if not exists driver_version text;
