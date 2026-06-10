"use client";

import { DEFAULT_LAVA_CONFIG, defaultLavaConfig, type LavaSceneConfig } from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { MicroLabel } from "@/app/components/ui";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

const SPEED_PRESETS = [0.25, 0.5, 1, 2];

/** Read a stored mode_config jsonb back into a typed config. */
export function parseLavaConfig(raw: unknown): LavaSceneConfig {
  if (!raw || typeof raw !== "object") return defaultLavaConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_LAVA_CONFIG.color);
  const glow = parseRgb(obj.glow, DEFAULT_LAVA_CONFIG.glow);
  const blob_count =
    typeof obj.blob_count === "number" && Number.isFinite(obj.blob_count)
      ? Math.round(Math.max(2, Math.min(8, obj.blob_count)))
      : DEFAULT_LAVA_CONFIG.blob_count;
  const speed =
    typeof obj.speed === "number" && obj.speed > 0
      ? Math.max(0.05, Math.min(4, obj.speed))
      : DEFAULT_LAVA_CONFIG.speed;
  const goo =
    typeof obj.goo === "number"
      ? Math.max(0, Math.min(1, obj.goo))
      : DEFAULT_LAVA_CONFIG.goo;
  return { color, glow, blob_count, speed, goo };
}

export function LavaComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: LavaSceneConfig;
}) {
  const [draft, update] = useComposerConfig<LavaSceneConfig>(
    panelId,
    "lava",
    config,
  );

  return (
    <ComposerShell
      title="lava"
      status="ambient · metaball lamp"
      ariaLabel="Lava configuration"
    >
      {/* Population */}
      <Fader
        label="blobs"
        value={draft.blob_count}
        min={2}
        max={8}
        step={1}
        onChange={(v) => update({ ...draft, blob_count: Math.round(v) })}
        format={(v) => `${Math.round(v)}`}
        endpoints={["calm", "crowded"]}
        ariaLabel="Blob count"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Motion + edge character */}
      <Fader
        label="speed"
        value={draft.speed}
        min={0.05}
        max={4}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["lazy", "boiling"]}
        presets={SPEED_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Drift speed"
      />

      <Fader
        label="goo"
        value={draft.goo}
        min={0}
        max={1}
        step={0.02}
        onChange={(goo) => update({ ...draft, goo })}
        format={(v) => `${Math.round(v * 100)}%`}
        endpoints={["crisp", "nebula"]}
        ariaLabel="Goo softness"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Blob core color */}
      <div>
        <MicroLabel as="div" className="mb-3">
          blob
        </MicroLabel>
        <SolidColorPicker
          value={draft.color}
          onChange={(color) => update({ ...draft, color })}
        />
      </div>

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Lamp fluid (background) color */}
      <div>
        <MicroLabel as="div" className="mb-3">
          fluid
        </MicroLabel>
        <SolidColorPicker
          value={draft.glow}
          onChange={(glow) => update({ ...draft, glow })}
        />
      </div>
    </ComposerShell>
  );
}
