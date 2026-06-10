"use client";

import {
  DEFAULT_SWARM_CONFIG,
  defaultSwarmConfig,
  type SwarmSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { MicroLabel } from "@/app/components/ui";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

const SPEED_PRESETS = [0.5, 1, 2];

/** Read a stored mode_config jsonb back into a typed config. */
export function parseSwarmConfig(raw: unknown): SwarmSceneConfig {
  if (!raw || typeof raw !== "object") return defaultSwarmConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_SWARM_CONFIG.color);
  const count =
    typeof obj.count === "number" && Number.isFinite(obj.count)
      ? Math.round(Math.max(10, Math.min(200, obj.count)))
      : DEFAULT_SWARM_CONFIG.count;
  const trail =
    typeof obj.trail === "number" && Number.isFinite(obj.trail)
      ? Math.max(0.5, Math.min(0.98, obj.trail))
      : DEFAULT_SWARM_CONFIG.trail;
  const speed =
    typeof obj.speed === "number" && Number.isFinite(obj.speed)
      ? Math.max(0.1, Math.min(4, obj.speed))
      : DEFAULT_SWARM_CONFIG.speed;
  return { color, count, trail, speed };
}

export function SwarmComposer({ panelId, config }: { panelId: string; config: SwarmSceneConfig }) {
  const [draft, update] = useComposerConfig<SwarmSceneConfig>(panelId, "swarm", config);

  return (
    <ComposerShell title="swarm" status="living simulation" ariaLabel="Swarm configuration">
      {/* Flock size */}
      <Fader
        label="count"
        value={draft.count}
        min={10}
        max={200}
        step={5}
        onChange={(v) => update({ ...draft, count: Math.round(v) })}
        format={(v) => `${Math.round(v)}`}
        endpoints={["few", "murmuration"]}
        ariaLabel="Boid count"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Trail persistence + flight speed */}
      <Fader
        label="trail"
        value={draft.trail}
        min={0.5}
        max={0.98}
        step={0.01}
        onChange={(trail) => update({ ...draft, trail })}
        format={(v) => v.toFixed(2)}
        endpoints={["crisp", "comet"]}
        ariaLabel="Trail persistence"
      />

      <Fader
        label="speed"
        value={draft.speed}
        min={0.1}
        max={4}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["drift", "dash"]}
        presets={SPEED_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Flight speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Boid/trail color */}
      <div>
        <MicroLabel as="div" className="mb-3">
          color
        </MicroLabel>
        <SolidColorPicker
          value={draft.color}
          onChange={(color) => update({ ...draft, color })}
        />
      </div>
    </ComposerShell>
  );
}
