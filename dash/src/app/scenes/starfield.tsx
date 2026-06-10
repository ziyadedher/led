"use client";

import {
  DEFAULT_STARFIELD_CONFIG,
  defaultStarfieldConfig,
  type StarfieldSceneConfig,
} from "./types";

import { CheckRow } from "@/app/components/CheckRow";
import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

const WARP_PRESETS = [0.5, 1, 3, 6];

/** Read a stored mode_config jsonb back into a typed config. */
export function parseStarfieldConfig(raw: unknown): StarfieldSceneConfig {
  if (!raw || typeof raw !== "object") return defaultStarfieldConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_STARFIELD_CONFIG.color);
  const warp =
    typeof obj.warp === "number" && obj.warp > 0
      ? Math.max(0.1, Math.min(8, obj.warp))
      : DEFAULT_STARFIELD_CONFIG.warp;
  const density =
    typeof obj.density === "number" && Number.isFinite(obj.density)
      ? Math.round(Math.max(8, Math.min(256, obj.density)))
      : DEFAULT_STARFIELD_CONFIG.density;
  const thermal =
    typeof obj.thermal === "boolean"
      ? obj.thermal
      : DEFAULT_STARFIELD_CONFIG.thermal;
  const twinkle =
    typeof obj.twinkle === "boolean"
      ? obj.twinkle
      : DEFAULT_STARFIELD_CONFIG.twinkle;
  return { color, warp, density, thermal, twinkle };
}

export function StarfieldComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: StarfieldSceneConfig;
}) {
  const [draft, update] = useComposerConfig<StarfieldSceneConfig>(
    panelId,
    "starfield",
    config,
  );

  return (
    <ComposerShell
      title="starfield"
      status="ambient · perspective flight"
      ariaLabel="Starfield configuration"
    >
      <Fader
        label="warp"
        value={draft.warp}
        min={0.1}
        max={8}
        step={0.1}
        onChange={(warp) => update({ ...draft, warp })}
        format={(v) => `${v.toFixed(1)}x`}
        endpoints={["drift", "hyperspace"]}
        presets={WARP_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Warp speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      <Fader
        label="density"
        value={draft.density}
        min={8}
        max={256}
        step={4}
        onChange={(density) => update({ ...draft, density: Math.round(density) })}
        format={(v) => `${Math.round(v)}`}
        endpoints={["sparse", "dense"]}
        ariaLabel="Star density"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      <CheckRow
        label="thermal tint"
        hint="speed-mapped blue → white → orange"
        checked={draft.thermal}
        onChange={(thermal) => update({ ...draft, thermal })}
      />

      <CheckRow
        label="twinkle"
        hint="shimmer at low warp"
        checked={draft.twinkle}
        onChange={(twinkle) => update({ ...draft, twinkle })}
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Star color — thermal tint overrides it, so (mirroring the
       * clock's meridiem row) the picker only renders when it would
       * actually take effect. A faint note keeps the section from
       * reading as missing. */}
      {draft.thermal ? (
        <p className="font-mono text-[9px] tracking-wide text-(--color-text-faint)">
          star color follows speed while thermal tint is on
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
