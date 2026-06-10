"use client";

import {
  DEFAULT_FX_CONFIG,
  defaultFxConfig,
  FX_EFFECTS,
  FX_PALETTES,
  oneOf,
  type FxEffect,
  type FxPalette,
  type FxSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { ControlRow } from "@/app/components/ControlRow";
import { Fader } from "@/app/components/Fader";
import { SegmentedToggle } from "@/app/components/SegmentedToggle";
import { FOCUS_RING, MicroLabel } from "@/app/components/ui";
import { useRovingRadio } from "@/app/components/useRovingRadio";
import { useComposerConfig } from "@/utils/useComposerConfig";

/** The ten effects in the pack, in FX_EFFECTS order. */
const EFFECTS: { id: FxEffect; label: string; glyph: string }[] = [
  { id: "Tunnel", label: "tunnel", glyph: "◎" },
  { id: "Rotozoom", label: "rotozoom", glyph: "▦" },
  { id: "Twister", label: "twister", glyph: "≋" },
  { id: "Copper", label: "copper", glyph: "▤" },
  { id: "Moire", label: "moire", glyph: "◍" },
  { id: "Kefrens", label: "kefrens", glyph: "ψ" },
  { id: "Julia", label: "julia", glyph: "❉" },
  { id: "Chladni", label: "chladni", glyph: "✳" },
  { id: "Aurora", label: "aurora", glyph: "∿" },
  { id: "BlackHole", label: "black hole", glyph: "●" },
];

const EFFECT_IDS = EFFECTS.map((e) => e.id);

const PALETTE_OPTIONS: { id: FxPalette; label: string }[] = FX_PALETTES.map(
  (p) => ({ id: p, label: p.toLowerCase() }),
);

/**
 * CSS approximations of the Rust-side 256-entry palette LUTs
 * (display_core::frames::fx::palette_lut) — same gradient stops,
 * mapped from LUT index 0..255 to percentages.
 */
const PALETTE_GRADIENTS: Record<FxPalette, string> = {
  Ember:
    "linear-gradient(90deg, #000 0%, #961602 38%, #ff8a2c 75%, #ffdcb4 100%)",
  Phosphor:
    "linear-gradient(90deg, #000 0%, #0a8237 38%, #5dffa9 75%, #e2fff0 100%)",
  Aurora:
    "linear-gradient(90deg, #02030e 0%, #081c60 31%, #12b4aa 63%, #8c5ce6 100%)",
  Rainbow:
    "linear-gradient(90deg, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 84%, #f00 100%)",
};

const SPEED_PRESETS = [0.5, 1, 2];

/** Read a stored mode_config jsonb back into a typed config. */
export function parseFxConfig(raw: unknown): FxSceneConfig {
  if (!raw || typeof raw !== "object") return defaultFxConfig();
  const obj = raw as Record<string, unknown>;
  const effect = oneOf(obj.effect, FX_EFFECTS, DEFAULT_FX_CONFIG.effect);
  const palette = oneOf(obj.palette, FX_PALETTES, DEFAULT_FX_CONFIG.palette);
  const speed =
    typeof obj.speed === "number" && Number.isFinite(obj.speed)
      ? Math.max(0.05, Math.min(8, obj.speed))
      : DEFAULT_FX_CONFIG.speed;
  return { effect, palette, speed };
}

export function FxComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: FxSceneConfig;
}) {
  const [draft, update] = useComposerConfig<FxSceneConfig>(
    panelId,
    "fx",
    config,
  );
  const effectRadio = useRovingRadio(EFFECT_IDS, draft.effect, (effect) =>
    update({ ...draft, effect }),
  );

  return (
    <ComposerShell
      title="fx"
      status="demoscene effect pack"
      ariaLabel="Fx configuration"
    >
      {/* Effect picker */}
      <div>
        <MicroLabel as="div" className="mb-3">
          effect
        </MicroLabel>
        <div
          role="radiogroup"
          aria-label="Effect"
          onKeyDown={effectRadio.onKeyDown}
          className="grid grid-cols-2 gap-px border border-(--color-border) bg-(--color-border) sm:grid-cols-5"
        >
          {EFFECTS.map((e, i) => {
            const active = e.id === draft.effect;
            return (
              <button
                key={e.id}
                {...effectRadio.itemProps(e.id, i)}
                className={[
                  "flex flex-col items-center gap-1.5 px-2 py-2.5 transition-colors",
                  FOCUS_RING,
                  "focus-visible:ring-inset",
                  active
                    ? "bg-(--color-bg) text-(--color-accent)"
                    : "bg-(--color-surface)/70 text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "flex h-7 w-7 shrink-0 items-center justify-center border font-pixel text-[18px] leading-none",
                    active
                      ? "border-(--color-accent)/60 bg-(--color-accent)/10 text-(--color-accent)"
                      : "border-(--color-border) bg-(--color-bg)/60 text-(--color-text-dim)",
                  ].join(" ")}
                >
                  {e.glyph}
                </span>
                <span className="w-full truncate text-center font-mono text-[10px] uppercase tracking-[0.2em]">
                  {e.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Palette */}
      <div className="space-y-2.5">
        <ControlRow label="palette">
          <SegmentedToggle
            options={PALETTE_OPTIONS}
            value={draft.palette}
            onChange={(palette) => update({ ...draft, palette })}
            ariaLabel="Fx palette"
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
        ariaLabel="Effect speed"
      />
    </ComposerShell>
  );
}
