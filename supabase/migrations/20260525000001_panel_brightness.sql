-- Global brightness. A final 0..1 multiplier the driver (and the WASM
-- simulator) apply to every pixel before output, mode-independent and
-- composing with is_paused / is_off the same way. 1.0 = full output;
-- rows predating this column default to full so nothing goes dark on
-- migration.

alter table public.panels
    add column if not exists brightness real not null default 1.0
        check (brightness >= 0 and brightness <= 1);
