-- "Off" toggle. Composes with mode + is_paused: when is_off=true the
-- driver short-circuits the render dispatch and clears to black,
-- without touching mode_config or losing pause/queue state. Lets a
-- user power-down a panel from the dash and resume to the same scene
-- with one click.

alter table public.panels
    add column if not exists is_off boolean not null default false;
