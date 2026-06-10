"use client";

import {
  DEFAULT_SAND_CONFIG,
  defaultSandConfig,
  type SandSceneConfig,
} from "./types";

import { CheckRow } from "@/app/components/CheckRow";
import { ComposerShell } from "@/app/components/ComposerShell";
import { ControlRow } from "@/app/components/ControlRow";
import { Fader } from "@/app/components/Fader";
import { SegmentedToggle } from "@/app/components/SegmentedToggle";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

/** Cycle presets — toggle ids mapped to reset_minutes values. */
const CYCLES = [
  { id: "continuous", label: "loop", minutes: 0, blurb: "fill, drain, refill — forever" },
  { id: "m15", label: "15m", minutes: 15, blurb: "hourglass: fills over 15 minutes" },
  { id: "hour", label: "1h", minutes: 60, blurb: "hourglass: fills over an hour" },
  { id: "day", label: "24h", minutes: 1440, blurb: "hourglass: fills over a day" },
] as const;

type CycleId = (typeof CYCLES)[number]["id"];

/** Read a stored mode_config jsonb back into a typed config. */
export function parseSandConfig(raw: unknown): SandSceneConfig {
  if (!raw || typeof raw !== "object") return defaultSandConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_SAND_CONFIG.color);
  const rainbow = typeof obj.rainbow === "boolean" ? obj.rainbow : DEFAULT_SAND_CONFIG.rainbow;
  const pour_rate =
    typeof obj.pour_rate === "number" && Number.isFinite(obj.pour_rate)
      ? Math.max(0.1, Math.min(4, obj.pour_rate))
      : DEFAULT_SAND_CONFIG.pour_rate;
  const reset_minutes =
    typeof obj.reset_minutes === "number" && Number.isFinite(obj.reset_minutes)
      ? Math.round(Math.max(0, Math.min(1440, obj.reset_minutes)))
      : DEFAULT_SAND_CONFIG.reset_minutes;
  return { color, rainbow, pour_rate, reset_minutes };
}

export function SandComposer({ panelId, config }: { panelId: string; config: SandSceneConfig }) {
  const [draft, update] = useComposerConfig<SandSceneConfig>(panelId, "sand", config);

  const activeCycle: CycleId =
    CYCLES.find((c) => c.minutes === draft.reset_minutes)?.id ?? "continuous";

  return (
    <ComposerShell
      title="sand"
      status="living simulation · falling grains"
      ariaLabel="Sand configuration"
    >
      <Fader
        label="pour"
        value={draft.pour_rate}
        min={0.1}
        max={4}
        step={0.05}
        onChange={(pour_rate) => update({ ...draft, pour_rate })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["trickle", "torrent"]}
        ariaLabel="Pour rate"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      <ControlRow label="cycle" hint="fill window before the drain opens">
        <SegmentedToggle
          ariaLabel="Fill/drain cycle"
          options={CYCLES.map((c) => ({ id: c.id, label: c.label, blurb: c.blurb }))}
          value={activeCycle}
          onChange={(id) => {
            const cycle = CYCLES.find((c) => c.id === id);
            if (cycle) update({ ...draft, reset_minutes: cycle.minutes });
          }}
        />
      </ControlRow>

      <div className="border-t border-dashed border-(--color-hairline)" />

      <CheckRow
        label="rainbow strata"
        hint="grain color cycles as the pile grows"
        checked={draft.rainbow}
        onChange={(rainbow) => update({ ...draft, rainbow })}
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Grain color — rainbow strata override it, so (mirroring
       * starfield's thermal-tint row) the picker only renders when it
       * would actually take effect. */}
      {draft.rainbow ? (
        <p className="font-mono text-[9px] tracking-wide text-(--color-text-faint)">
          grain color follows the strata while rainbow is on
        </p>
      ) : (
        <SolidColorPicker
          value={draft.color}
          onChange={(color) => update({ ...draft, color })}
        />
      )}
    </ComposerShell>
  );
}
