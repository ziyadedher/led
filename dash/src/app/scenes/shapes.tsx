"use client";

import {
  DEFAULT_SHAPES_CONFIG,
  defaultShapesConfig,
  oneOf,
  SHAPE_KINDS,
  type ShapeKind,
  type ShapesSceneConfig,
} from "./types";

import { CheckRow } from "@/app/components/CheckRow";
import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { FOCUS_RING, MicroLabel } from "@/app/components/ui";
import { useRovingRadio } from "@/app/components/useRovingRadio";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

const SHAPES: { id: ShapeKind; label: string; glyph: string; blurb: string }[] = [
  { id: "Cube", label: "cube", glyph: "▣", blurb: "8v · 12e" },
  { id: "Tetrahedron", label: "tetra", glyph: "△", blurb: "4v · 6e" },
  { id: "Octahedron", label: "octa", glyph: "◈", blurb: "6v · 12e" },
  { id: "Icosahedron", label: "icosa", glyph: "✦", blurb: "12v · 30e" },
  { id: "Torus", label: "torus", glyph: "◯", blurb: "donut" },
  { id: "Hypercube", label: "tesseract", glyph: "◫", blurb: "4d cube" },
];

const SHAPE_IDS = SHAPES.map((s) => s.id);

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4, 8];

export function parseShapesConfig(raw: unknown): ShapesSceneConfig {
  if (!raw || typeof raw !== "object") return defaultShapesConfig();
  const obj = raw as Record<string, unknown>;
  const kind = oneOf(obj.kind, SHAPE_KINDS, DEFAULT_SHAPES_CONFIG.kind);
  const color = parseRgb(obj.color, DEFAULT_SHAPES_CONFIG.color);
  const speed =
    typeof obj.speed === "number" && obj.speed > 0
      ? Math.max(0.05, Math.min(16, obj.speed))
      : 1;
  const depth_shade = Boolean(obj.depth_shade);
  const opacity =
    typeof obj.opacity === "number"
      ? Math.max(0, Math.min(1, obj.opacity))
      : 0;
  return { kind, color, speed, depth_shade, opacity };
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
  const [draft, update] = useComposerConfig<ShapesSceneConfig>(
    panelId,
    "shapes",
    config,
  );
  const shapeRadio = useRovingRadio(SHAPE_IDS, draft.kind, (kind) =>
    update({ ...draft, kind }),
  );

  return (
    <ComposerShell
      title="shapes"
      status="rotating wireframe"
      ariaLabel="Shapes configuration"
    >
      {/* Shape picker */}
      <div>
        <MicroLabel as="div" className="mb-3">
          shape
        </MicroLabel>
        <div
          role="radiogroup"
          aria-label="Shape"
          onKeyDown={shapeRadio.onKeyDown}
          className="grid grid-cols-2 gap-px border border-(--color-border) bg-(--color-border) sm:grid-cols-3"
        >
          {SHAPES.map((s, i) => {
            const active = s.id === draft.kind;
            return (
              <button
                key={s.id}
                {...shapeRadio.itemProps(s.id, i)}
                title={s.blurb}
                className={[
                  "flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
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
                  {s.glyph}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[11px] uppercase tracking-[0.3em]">
                    {s.label}
                  </span>
                  <span
                    className={[
                      "truncate font-mono text-[10px] tracking-wide",
                      active
                        ? "text-(--color-accent)"
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
      <Fader
        label="speed"
        value={draft.speed}
        min={SPEED_PRESETS[0]}
        max={SPEED_PRESETS[SPEED_PRESETS.length - 1]}
        step={0.05}
        onChange={(speed) => update({ ...draft, speed })}
        format={(v) => `${v.toFixed(2)}x`}
        endpoints={["slow", "fast"]}
        presets={SPEED_PRESETS}
        presetLabel={(v) => `${v}x`}
        ariaLabel="Rotation speed"
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Face opacity — 0 = wireframe-only, 1 = fully filled. Edges
       * are always drawn on top at full brightness regardless. */}
      <Fader
        label="face opacity"
        value={draft.opacity}
        min={0}
        max={1}
        step={0.02}
        onChange={(opacity) => update({ ...draft, opacity })}
        format={(v) => `${Math.round(v * 100)}%`}
        endpoints={["wire", "solid"]}
        ariaLabel="Face opacity"
      />

      <CheckRow
        label="depth shade"
        hint="dim back-of-shape edges"
        checked={draft.depth_shade}
        onChange={(depth_shade) => update({ ...draft, depth_shade })}
      />

      <div className="border-t border-dashed border-(--color-hairline)" />

      {/* Color */}
      <SolidColorPicker
        value={draft.color}
        onChange={(color) => update({ ...draft, color })}
      />
    </ComposerShell>
  );
}
