"use client";

import {
  DEFAULT_PHYSARUM_CONFIG,
  defaultPhysarumConfig,
  type PhysarumSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { MicroLabel } from "@/app/components/ui";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

const SPEED_PRESETS = [0.5, 1, 2];

/** Read a stored mode_config jsonb back into a typed config. */
export function parsePhysarumConfig(raw: unknown): PhysarumSceneConfig {
  if (!raw || typeof raw !== "object") return defaultPhysarumConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_PHYSARUM_CONFIG.color);
  const agents =
    typeof obj.agents === "number" && Number.isFinite(obj.agents)
      ? Math.round(Math.max(200, Math.min(8000, obj.agents)))
      : DEFAULT_PHYSARUM_CONFIG.agents;
  const decay =
    typeof obj.decay === "number" && Number.isFinite(obj.decay)
      ? Math.max(0.8, Math.min(0.99, obj.decay))
      : DEFAULT_PHYSARUM_CONFIG.decay;
  const speed =
    typeof obj.speed === "number" && Number.isFinite(obj.speed)
      ? Math.max(0.1, Math.min(4, obj.speed))
      : DEFAULT_PHYSARUM_CONFIG.speed;
  return { color, agents, decay, speed };
}

export function PhysarumComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: PhysarumSceneConfig;
}) {
  const [draft, update] = useComposerConfig<PhysarumSceneConfig>(
    panelId,
    "physarum",
    config,
  );

  return (
    <ComposerShell
      title="physarum"
      status="living simulation · slime mold"
      ariaLabel="Physarum configuration"
    >
      {/* Population */}
      <Fader
        label="agents"
        value={draft.agents}
        min={200}
        max={8000}
        step={100}
        onChange={(v) => update({ ...draft, agents: Math.round(v) })}
        format={(v) => `${Math.round(v)}`}
        endpoints={["sparse", "dense"]}
        ariaLabel="Agent count"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Trail persistence */}
      <Fader
        label="decay"
        value={draft.decay}
        min={0.8}
        max={0.99}
        step={0.005}
        onChange={(decay) => update({ ...draft, decay })}
        format={(v) => v.toFixed(3)}
        endpoints={["wispy", "lingering"]}
        ariaLabel="Trail decay"
      />

      <Fader
        label="speed"
        value={draft.speed}
        min={0.1}
        max={4}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["creep", "race"]}
        presets={SPEED_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Sim speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Trail color */}
      <div>
        <MicroLabel as="div" className="mb-3">
          trail
        </MicroLabel>
        <SolidColorPicker
          value={draft.color}
          onChange={(color) => update({ ...draft, color })}
        />
      </div>
    </ComposerShell>
  );
}
