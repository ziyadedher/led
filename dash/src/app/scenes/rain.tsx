"use client";

import { DEFAULT_RAIN_CONFIG, defaultRainConfig, type RainSceneConfig } from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

const SPEED_PRESETS = [0.5, 1, 2];

/** Read a stored mode_config jsonb back into a typed config. */
export function parseRainConfig(raw: unknown): RainSceneConfig {
  if (!raw || typeof raw !== "object") return defaultRainConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_RAIN_CONFIG.color);
  const density =
    typeof obj.density === "number"
      ? Math.max(0, Math.min(1, obj.density))
      : DEFAULT_RAIN_CONFIG.density;
  const speed =
    typeof obj.speed === "number" && obj.speed > 0
      ? Math.max(0.1, Math.min(4, obj.speed))
      : DEFAULT_RAIN_CONFIG.speed;
  const tail =
    typeof obj.tail === "number" && Number.isFinite(obj.tail)
      ? Math.round(Math.max(2, Math.min(48, obj.tail)))
      : DEFAULT_RAIN_CONFIG.tail;
  return { color, density, speed, tail };
}

export function RainComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: RainSceneConfig;
}) {
  const [draft, update] = useComposerConfig<RainSceneConfig>(
    panelId,
    "rain",
    config,
  );

  return (
    <ComposerShell
      title="rain"
      status="ambient · digital rain"
      ariaLabel="Rain configuration"
    >
      {/* Density — how many columns carry a stream per pass. */}
      <Fader
        label="density"
        value={draft.density}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(density) => update({ ...draft, density })}
        format={(v) => `${Math.round(v * 100)}%`}
        endpoints={["sparse", "torrent"]}
        ariaLabel="Stream density"
      />

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
        endpoints={["drizzle", "downpour"]}
        presets={SPEED_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Fall speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Tail length */}
      <Fader
        label="tail"
        value={draft.tail}
        min={2}
        max={48}
        step={1}
        onChange={(tail) => update({ ...draft, tail: Math.round(tail) })}
        format={(v) => `${Math.round(v)}px`}
        endpoints={["short", "long"]}
        ariaLabel="Tail length"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Stream color */}
      <SolidColorPicker
        value={draft.color}
        onChange={(color) => update({ ...draft, color })}
      />
    </ComposerShell>
  );
}
