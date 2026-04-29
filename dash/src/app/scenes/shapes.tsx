"use client";

import { useState } from "react";

import {
  DEFAULT_SHAPES_CONFIG,
  type ShapeKind,
  type ShapesSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { panels } from "@/utils/actions";

const SHAPES: { id: ShapeKind; label: string; glyph: string; blurb: string }[] = [
  { id: "Cube", label: "cube", glyph: "▣", blurb: "8v · 12e" },
  { id: "Tetrahedron", label: "tetra", glyph: "△", blurb: "4v · 6e" },
  { id: "Octahedron", label: "octa", glyph: "◈", blurb: "6v · 12e" },
  { id: "Icosahedron", label: "icosa", glyph: "✦", blurb: "12v · 30e" },
  { id: "Torus", label: "torus", glyph: "◯", blurb: "donut" },
  { id: "Hypercube", label: "tesseract", glyph: "◫", blurb: "4d cube" },
];

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4, 8];

export function parseShapesConfig(raw: unknown): ShapesSceneConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_SHAPES_CONFIG;
  const obj = raw as Record<string, unknown>;
  const kind = isShapeKind(obj.kind) ? obj.kind : DEFAULT_SHAPES_CONFIG.kind;
  const colorRaw =
    obj.color && typeof obj.color === "object"
      ? (obj.color as Record<string, unknown>)
      : null;
  const color = colorRaw
    ? {
        r: clamp255(colorRaw.r),
        g: clamp255(colorRaw.g),
        b: clamp255(colorRaw.b),
      }
    : DEFAULT_SHAPES_CONFIG.color;
  const speed =
    typeof obj.speed === "number" && obj.speed > 0
      ? Math.max(0.05, Math.min(16, obj.speed))
      : 1;
  const depth_shade = Boolean(obj.depth_shade);
  return { kind, color, speed, depth_shade };
}

function isShapeKind(v: unknown): v is ShapeKind {
  return (
    v === "Cube" ||
    v === "Tetrahedron" ||
    v === "Octahedron" ||
    v === "Icosahedron" ||
    v === "Torus" ||
    v === "Hypercube"
  );
}

function clamp255(n: unknown): number {
  const v = typeof n === "number" ? n : 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Composer for shapes mode. Optimistic local state mirrors clock/life:
 * persists every change to Supabase, but holds an in-memory copy so
 * the form doesn't snap when an unrelated panel field updates.
 */
export function ShapesComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: ShapesSceneConfig;
}) {
  const configKey = JSON.stringify(config);
  const [snapshotKey, setSnapshotKey] = useState(configKey);
  const [local, setLocal] = useState<ShapesSceneConfig>(config);
  if (snapshotKey !== configKey) {
    setSnapshotKey(configKey);
    setLocal(config);
  }

  const persist = (next: ShapesSceneConfig) => {
    setLocal(next);
    void panels.setMode.call(panelId, "shapes", next);
  };

  const speedPct =
    ((local.speed - SPEED_PRESETS[0]) /
      (SPEED_PRESETS[SPEED_PRESETS.length - 1] - SPEED_PRESETS[0])) *
    100;

  return (
    <ComposerShell
      title="shapes"
      status="rotating wireframe"
      ariaLabel="Shapes configuration"
    >
      <div className="space-y-6 px-4 pb-5 pt-5">
        {/* Shape picker */}
        <div>
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
            :: shape
          </div>
          <div className="grid grid-cols-2 gap-px border border-(--color-border) bg-(--color-border) sm:grid-cols-3">
            {SHAPES.map((s) => {
              const active = s.id === local.kind;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => persist({ ...local, kind: s.id })}
                  aria-pressed={active}
                  title={s.blurb}
                  className={[
                    "flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
                    active
                      ? "bg-(--color-bg) text-(--color-accent)"
                      : "bg-(--color-surface)/70 text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
                  ].join(" ")}
                >
                  <span
                    aria-hidden
                    className={[
                      "flex h-7 w-7 shrink-0 items-center justify-center border",
                      active
                        ? "border-(--color-accent)/60 bg-(--color-accent)/10 text-(--color-accent)"
                        : "border-(--color-border) bg-(--color-bg)/60 text-(--color-text-dim)",
                    ].join(" ")}
                    style={{
                      fontFamily: "var(--font-pixel)",
                      fontSize: 18,
                      lineHeight: 1,
                    }}
                  >
                    {s.glyph}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[11px] uppercase tracking-[0.3em]">
                      {s.label}
                    </span>
                    <span
                      className={[
                        "truncate font-mono text-[9px] tracking-wide",
                        active
                          ? "text-(--color-accent)/70"
                          : "text-(--color-text-faint)",
                      ].join(" ")}
                    >
                      {s.blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-dashed border-(--color-hairline)" />

        {/* Speed */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
              {"// speed"}
            </span>
            <span
              className="tabular-nums text-(--color-text)"
              style={{ fontFamily: "var(--font-pixel)", fontSize: 14 }}
            >
              {local.speed.toFixed(2)}x
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
              slow
            </span>
            <input
              type="range"
              min={SPEED_PRESETS[0]}
              max={SPEED_PRESETS[SPEED_PRESETS.length - 1]}
              step={0.05}
              value={local.speed}
              onChange={(e) =>
                persist({ ...local, speed: Number(e.target.value) })
              }
              className="fader flex-1"
              style={
                { ["--fader-pos" as string]: `${speedPct}%` } as React.CSSProperties
              }
              aria-label="Rotation speed"
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
              fast
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {SPEED_PRESETS.map((p) => {
              const active = Math.abs(local.speed - p) < 0.01;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => persist({ ...local, speed: p })}
                  className={[
                    "border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.25em] transition-colors",
                    active
                      ? "border-(--color-accent) bg-(--color-accent)/15 text-(--color-accent)"
                      : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)",
                  ].join(" ")}
                >
                  {p}x
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-dashed border-(--color-hairline)" />

        {/* Depth shade */}
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
              :: depth shade
            </span>
            <span className="font-mono text-[9px] tracking-wide text-(--color-text-faint)">
              dim back-of-shape edges
            </span>
          </span>
          <input
            type="checkbox"
            checked={local.depth_shade}
            onChange={(e) =>
              persist({ ...local, depth_shade: e.target.checked })
            }
            className="h-3.5 w-3.5 rounded-[1px] border-(--color-border-strong) bg-(--color-bg) text-(--color-accent) focus:ring-0 focus:ring-offset-0"
          />
        </label>

        <div className="border-t border-dashed border-(--color-hairline)" />

        {/* Color */}
        <SolidColorPicker
          value={local.color}
          onChange={(next) => persist({ ...local, color: next })}
        />
      </div>
    </ComposerShell>
  );
}
