"use client";

import {
  DEFAULT_PONG_CONFIG,
  defaultPongConfig,
  oneOf,
  type PongScene,
  type PongSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { ControlRow } from "@/app/components/ControlRow";
import { Fader } from "@/app/components/Fader";
import { SegmentedToggle } from "@/app/components/SegmentedToggle";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

/** Read a stored mode_config jsonb back into a typed config. */
export function parsePongConfig(raw: unknown): PongSceneConfig {
  if (!raw || typeof raw !== "object") return defaultPongConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_PONG_CONFIG.color);
  const format = oneOf(obj.format, ["H24", "H12"] as const, DEFAULT_PONG_CONFIG.format);
  const speed =
    typeof obj.speed === "number" && Number.isFinite(obj.speed)
      ? Math.max(0.25, Math.min(4, obj.speed))
      : DEFAULT_PONG_CONFIG.speed;
  return { color, speed, format };
}

/** Build the render frame: config + local wall-clock (the score). */
export function pongSceneFromConfig(config: PongSceneConfig): PongScene {
  const d = new Date();
  return {
    ...config,
    now: { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() },
  };
}

/**
 * Composer-side configuration for the pong clock. Optimistic local
 * state; persisted to Supabase on a small debounce (clock.tsx style).
 */
export function PongComposer({ panelId, config }: { panelId: string; config: PongSceneConfig }) {
  const [draft, update] = useComposerConfig<PongSceneConfig>(panelId, "pong", config);
  return (
    <ComposerShell title="pong" status="the score is the time" ariaLabel="Pong clock configuration">
      <ControlRow label="format">
        <SegmentedToggle<"H12" | "H24">
          ariaLabel="Time format"
          options={[
            { id: "H24", label: "24h" },
            { id: "H12", label: "12h" },
          ]}
          value={draft.format}
          onChange={(format) => update({ ...draft, format })}
        />
      </ControlRow>

      <Fader
        label="speed"
        value={draft.speed}
        min={0.25}
        max={4}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["rally", "blitz"]}
        ariaLabel="Rally speed"
      />

      <SolidColorPicker value={draft.color} onChange={(color) => update({ ...draft, color })} />

      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
        the score is the time · the right side misses on the minute
      </p>
    </ComposerShell>
  );
}
