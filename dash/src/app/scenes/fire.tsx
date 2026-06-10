"use client";

import {
  DEFAULT_FIRE_CONFIG,
  defaultFireConfig,
  FIRE_PALETTES,
  oneOf,
  type FirePalette,
  type FireSceneConfig,
} from "./types";

import { CheckRow } from "@/app/components/CheckRow";
import { ComposerShell } from "@/app/components/ComposerShell";
import { ControlRow } from "@/app/components/ControlRow";
import { Fader } from "@/app/components/Fader";
import { SegmentedToggle } from "@/app/components/SegmentedToggle";
import { useComposerConfig } from "@/utils/useComposerConfig";

const PALETTE_OPTIONS: { id: FirePalette; label: string; blurb: string }[] = [
  { id: "Classic", label: "classic", blurb: "black → red → yellow → white" },
  { id: "Gas", label: "gas", blurb: "black → blue → cyan → white" },
  { id: "Phosphor", label: "phosphor", blurb: "black → green → mint" },
];

/** CSS mirror of the Rust palette LUT stops (fire.rs). */
const PALETTE_GRADIENTS: Record<FirePalette, string> = {
  Classic:
    "linear-gradient(90deg, #000 0%, #400000 15%, #c81000 35%, #ff6000 55%, #ffd228 78%, #ffffdc 100%)",
  Gas: "linear-gradient(90deg, #000 0%, #080c50 20%, #1840e0 45%, #20c8ff 72%, #ebffff 100%)",
  Phosphor:
    "linear-gradient(90deg, #000 0%, #084018 30%, #5dffa9 70%, #d2ffe6 100%)",
};

const WIND_PRESETS = [-0.5, 0, 0.5];

const formatWind = (v: number) =>
  `${v < 0 ? "-" : "+"}${Math.abs(v).toFixed(2)}`;

/** Read a stored mode_config jsonb back into a typed config. */
export function parseFireConfig(raw: unknown): FireSceneConfig {
  if (!raw || typeof raw !== "object") return defaultFireConfig();
  const obj = raw as Record<string, unknown>;
  const palette = oneOf(obj.palette, FIRE_PALETTES, DEFAULT_FIRE_CONFIG.palette);
  const intensity =
    typeof obj.intensity === "number"
      ? Math.max(0, Math.min(1, obj.intensity))
      : DEFAULT_FIRE_CONFIG.intensity;
  const wind =
    typeof obj.wind === "number"
      ? Math.max(-1, Math.min(1, obj.wind))
      : DEFAULT_FIRE_CONFIG.wind;
  const embers =
    typeof obj.embers === "boolean" ? obj.embers : DEFAULT_FIRE_CONFIG.embers;
  return { palette, intensity, wind, embers };
}

export function FireComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: FireSceneConfig;
}) {
  const [draft, update] = useComposerConfig<FireSceneConfig>(
    panelId,
    "fire",
    config,
  );

  return (
    <ComposerShell
      title="fire"
      status="ambient · procedural flame"
      ariaLabel="Fire configuration"
    >
      {/* Palette */}
      <div className="space-y-2.5">
        <ControlRow label="palette">
          <SegmentedToggle
            options={PALETTE_OPTIONS}
            value={draft.palette}
            onChange={(palette) => update({ ...draft, palette })}
            ariaLabel="Heat palette"
          />
        </ControlRow>
        {/* Gradient strip mirroring the selected palette's heat ramp. */}
        <div
          aria-hidden
          className="h-1.5 w-full border border-(--color-border)"
          style={{ background: PALETTE_GRADIENTS[draft.palette] }}
        />
      </div>

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Flame dynamics */}
      <Fader
        label="intensity"
        value={draft.intensity}
        min={0.1}
        max={1}
        step={0.02}
        onChange={(intensity) => update({ ...draft, intensity })}
        format={(v) => `${Math.round(v * 100)}%`}
        endpoints={["embers", "inferno"]}
        ariaLabel="Flame intensity"
      />

      <Fader
        label="wind"
        value={draft.wind}
        min={-1}
        max={1}
        step={0.05}
        onChange={(wind) => update({ ...draft, wind })}
        format={formatWind}
        endpoints={["west", "east"]}
        presets={WIND_PRESETS}
        presetLabel={(v) => (v === 0 ? "calm" : formatWind(v))}
        ariaLabel="Wind"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      <CheckRow
        label="embers"
        hint="detached sparks above the tips"
        checked={draft.embers}
        onChange={(embers) => update({ ...draft, embers })}
      />
    </ComposerShell>
  );
}
