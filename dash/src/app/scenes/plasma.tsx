"use client";

import {
  DEFAULT_PLASMA_CONFIG,
  defaultPlasmaConfig,
  oneOf,
  PLASMA_PALETTES,
  type PlasmaPalette,
  type PlasmaSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { ControlRow } from "@/app/components/ControlRow";
import { Fader } from "@/app/components/Fader";
import { SegmentedToggle } from "@/app/components/SegmentedToggle";
import { useComposerConfig } from "@/utils/useComposerConfig";

const PALETTE_OPTIONS: { id: PlasmaPalette; label: string }[] =
  PLASMA_PALETTES.map((p) => ({ id: p, label: p.toLowerCase() }));

/**
 * CSS approximations of the Rust-side 256-entry palette LUTs
 * (display_core::frames::plasma) — same gradient stops, mapped from
 * LUT index 0..255 to percentages.
 */
const PALETTE_GRADIENTS: Record<PlasmaPalette, string> = {
  Ember:
    "linear-gradient(90deg, #000 0%, #1a0200 39%, #961602 67%, #ff8a2c 86%, #ffdcb4 100%)",
  Phosphor:
    "linear-gradient(90deg, #000 0%, #001608 39%, #0a8237 67%, #5dffa9 86%, #e2fff0 100%)",
  Aurora:
    "linear-gradient(90deg, #02030e 0%, #081c60 35%, #12b4aa 63%, #8c5ce6 84%, #502496 100%)",
  Rainbow:
    "linear-gradient(90deg, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
};

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];
const SCALE_PRESETS = [0.5, 1, 2, 3];

/** Read a stored mode_config jsonb back into a typed config. */
export function parsePlasmaConfig(raw: unknown): PlasmaSceneConfig {
  if (!raw || typeof raw !== "object") return defaultPlasmaConfig();
  const obj = raw as Record<string, unknown>;
  const palette = oneOf(
    obj.palette,
    PLASMA_PALETTES,
    DEFAULT_PLASMA_CONFIG.palette,
  );
  const speed =
    typeof obj.speed === "number" && obj.speed > 0
      ? Math.max(0.05, Math.min(8, obj.speed))
      : DEFAULT_PLASMA_CONFIG.speed;
  const scale =
    typeof obj.scale === "number" && obj.scale > 0
      ? Math.max(0.25, Math.min(4, obj.scale))
      : DEFAULT_PLASMA_CONFIG.scale;
  return { palette, speed, scale };
}

export function PlasmaComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: PlasmaSceneConfig;
}) {
  const [draft, update] = useComposerConfig<PlasmaSceneConfig>(
    panelId,
    "plasma",
    config,
  );

  return (
    <ComposerShell
      title="plasma"
      status="ambient · sine fields"
      ariaLabel="Plasma configuration"
    >
      {/* Palette */}
      <div className="space-y-2.5">
        <ControlRow label="palette">
          <SegmentedToggle
            options={PALETTE_OPTIONS}
            value={draft.palette}
            onChange={(palette) => update({ ...draft, palette })}
            ariaLabel="Plasma palette"
          />
        </ControlRow>
        {/* Preview strip of the selected palette's gradient ramp. */}
        <div
          aria-hidden
          className="h-1.5 w-full border border-(--color-border)"
          style={{ background: PALETTE_GRADIENTS[draft.palette] }}
        />
      </div>

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Speed */}
      <Fader
        label="speed"
        value={draft.speed}
        min={0.1}
        max={4}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["lazy", "frantic"]}
        presets={SPEED_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Plasma speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Scale */}
      <Fader
        label="scale"
        value={draft.scale}
        min={0.25}
        max={4}
        step={0.05}
        onChange={(scale) => update({ ...draft, scale })}
        format={(v) => `×${v.toFixed(2)}`}
        endpoints={["fine", "broad"]}
        presets={SCALE_PRESETS}
        presetLabel={(v) => `×${v}`}
        ariaLabel="Plasma scale"
      />
    </ComposerShell>
  );
}
