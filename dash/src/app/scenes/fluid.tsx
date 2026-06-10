"use client";

import {
  DEFAULT_FLUID_CONFIG,
  defaultFluidConfig,
  type FluidSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { MicroLabel } from "@/app/components/ui";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

const SPEED_PRESETS = [0.5, 1, 2];

/** Read a stored mode_config jsonb back into a typed config. */
export function parseFluidConfig(raw: unknown): FluidSceneConfig {
  if (!raw || typeof raw !== "object") return defaultFluidConfig();
  const obj = raw as Record<string, unknown>;
  const color_a = parseRgb(obj.color_a, DEFAULT_FLUID_CONFIG.color_a);
  const color_b = parseRgb(obj.color_b, DEFAULT_FLUID_CONFIG.color_b);
  const swirl =
    typeof obj.swirl === "number" && Number.isFinite(obj.swirl)
      ? Math.max(0.2, Math.min(4, obj.swirl))
      : DEFAULT_FLUID_CONFIG.swirl;
  const speed =
    typeof obj.speed === "number" && Number.isFinite(obj.speed)
      ? Math.max(0.1, Math.min(4, obj.speed))
      : DEFAULT_FLUID_CONFIG.speed;
  return { color_a, color_b, swirl, speed };
}

export function FluidComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: FluidSceneConfig;
}) {
  const [draft, update] = useComposerConfig<FluidSceneConfig>(
    panelId,
    "fluid",
    config,
  );

  return (
    <ComposerShell
      title="fluid"
      status="living simulation · stable fluids"
      ariaLabel="Fluid configuration"
    >
      {/* Injector strength */}
      <Fader
        label="swirl"
        value={draft.swirl}
        min={0.2}
        max={4}
        step={0.05}
        onChange={(swirl) => update({ ...draft, swirl })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["gentle", "churning"]}
        ariaLabel="Swirl strength"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Sim rate */}
      <Fader
        label="speed"
        value={draft.speed}
        min={0.1}
        max={4}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["syrup", "rapids"]}
        presets={SPEED_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Sim speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* First dye color */}
      <div>
        <MicroLabel as="div" className="mb-3">
          dye a
        </MicroLabel>
        <SolidColorPicker
          value={draft.color_a}
          onChange={(color_a) => update({ ...draft, color_a })}
        />
      </div>

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Second dye color */}
      <div>
        <MicroLabel as="div" className="mb-3">
          dye b
        </MicroLabel>
        <SolidColorPicker
          value={draft.color_b}
          onChange={(color_b) => update({ ...draft, color_b })}
        />
      </div>
    </ComposerShell>
  );
}
