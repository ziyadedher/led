"use client";

import {
  DEFAULT_RD_CONFIG,
  defaultRdConfig,
  type RdSceneConfig,
} from "./types";

import { CheckRow } from "@/app/components/CheckRow";
import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { FOCUS_RING, MicroLabel } from "@/app/components/ui";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

/** Read a stored mode_config jsonb back into a typed config. */
export function parseRdConfig(raw: unknown): RdSceneConfig {
  if (!raw || typeof raw !== "object") return defaultRdConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_RD_CONFIG.color);
  const feed =
    typeof obj.feed === "number" && Number.isFinite(obj.feed)
      ? Math.max(0.01, Math.min(0.12, obj.feed))
      : DEFAULT_RD_CONFIG.feed;
  const kill =
    typeof obj.kill === "number" && Number.isFinite(obj.kill)
      ? Math.max(0.04, Math.min(0.08, obj.kill))
      : DEFAULT_RD_CONFIG.kill;
  const drift = typeof obj.drift === "boolean" ? obj.drift : DEFAULT_RD_CONFIG.drift;
  const speed =
    typeof obj.speed === "number" && Number.isFinite(obj.speed)
      ? Math.max(0.1, Math.min(4, obj.speed))
      : DEFAULT_RD_CONFIG.speed;
  return { color, feed, kill, drift, speed };
}

/** Named (feed, kill) points in the Gray-Scott parameter plane —
 * chips set both at once to jump between pattern regimes. */
const REGIMES: { label: string; feed: number; kill: number }[] = [
  { label: "mitosis", feed: 0.0367, kill: 0.0649 },
  { label: "coral", feed: 0.0545, kill: 0.062 },
  { label: "stripes", feed: 0.022, kill: 0.051 },
  { label: "worms", feed: 0.078, kill: 0.061 },
];

/** Half a fader step — close enough to call a chip "active". */
const EPS = 0.00025;

export function RdComposer({ panelId, config }: { panelId: string; config: RdSceneConfig }) {
  const [draft, update] = useComposerConfig<RdSceneConfig>(panelId, "rd", config);

  return (
    <ComposerShell
      title="rd"
      status="reaction-diffusion · gray-scott"
      ariaLabel="Rd configuration"
    >
      {/* Chemistry — with drift on, these are the orbit center. */}
      <Fader
        label="feed"
        value={draft.feed}
        min={0.02}
        max={0.09}
        step={0.0005}
        onChange={(feed) => update({ ...draft, feed })}
        format={(v) => v.toFixed(4)}
        endpoints={["sparse", "lush"]}
        ariaLabel="Feed rate"
      />

      <Fader
        label="kill"
        value={draft.kill}
        min={0.045}
        max={0.07}
        step={0.0005}
        onChange={(kill) => update({ ...draft, kill })}
        format={(v) => v.toFixed(4)}
        endpoints={["blobs", "filigree"]}
        ariaLabel="Kill rate"
      />

      {/* Regime presets — set feed + kill together (a 2-D jump, so
       * these can't ride the single-value Fader presets prop). Chip
       * styling mirrors Fader's preset chips. */}
      <div>
        <MicroLabel as="div" className="mb-2">
          regime
        </MicroLabel>
        <div className="flex flex-wrap items-center gap-1">
          {REGIMES.map((r) => {
            const active =
              Math.abs(draft.feed - r.feed) < EPS &&
              Math.abs(draft.kill - r.kill) < EPS;
            return (
              <button
                key={r.label}
                type="button"
                onClick={() => update({ ...draft, feed: r.feed, kill: r.kill })}
                className={[
                  "border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.25em] transition-colors",
                  FOCUS_RING,
                  active
                    ? "border-(--color-accent) bg-(--color-accent)/15 text-(--color-accent)"
                    : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)",
                ].join(" ")}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <CheckRow
        label="drift"
        hint="wander between pattern regimes"
        checked={draft.drift}
        onChange={(drift) => update({ ...draft, drift })}
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Integration rate */}
      <Fader
        label="speed"
        value={draft.speed}
        min={0.1}
        max={4}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["geologic", "frantic"]}
        ariaLabel="Sim speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Pattern color */}
      <SolidColorPicker
        value={draft.color}
        onChange={(color) => update({ ...draft, color })}
      />
    </ComposerShell>
  );
}
