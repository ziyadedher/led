"use client";

import { useState } from "react";

import { hexToRgb, rgbToHex, type Rgb } from "@/utils/color";

const PRESETS = [
  { hex: "#FF8A2C", label: "amber" },
  { hex: "#FF4D6D", label: "rose" },
  { hex: "#FFE066", label: "sun" },
  { hex: "#A6E22E", label: "lime" },
  { hex: "#4DE0E0", label: "cyan" },
  { hex: "#4DA3FF", label: "azure" },
  { hex: "#A04DFF", label: "violet" },
  { hex: "#FFFFFF", label: "white" },
];

/**
 * Single-color picker shared across every scene composer that
 * needs to pick one Rgb value (clock, life, image-tint-tbd, etc.).
 * The text-mode `ColorPicker` (which adds a rainbow alternative)
 * delegates to this component for its rgb branch — there's exactly
 * one solid-color UX in the dash, in one place.
 *
 * UX: live swatch, hex text input, RGB readout, plus a preset grid.
 * Hex input keeps a draft string so partial typing doesn't fight
 * the parent's value; only commits on a fully-formed 6-digit hex.
 */
export function SolidColorPicker({
  value,
  onChange,
}: {
  value: Rgb;
  onChange: (next: Rgb) => void;
}) {
  const valueHex = rgbToHex(value);
  const [draft, setDraft] = useState(valueHex);
  const [snapshot, setSnapshot] = useState(valueHex);
  if (snapshot !== valueHex) {
    setSnapshot(valueHex);
    setDraft(valueHex);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-5 w-5 shrink-0 border border-(--color-border-strong)"
          style={{
            backgroundColor: valueHex,
            boxShadow: `0 0 10px -2px ${valueHex}`,
          }}
          aria-hidden
        />
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            const rgb = hexToRgb(next);
            if (rgb) onChange(rgb);
          }}
          spellCheck={false}
          className="flex-1 border-0 border-b border-(--color-border-strong) bg-transparent p-0 pb-0.5 font-mono text-sm uppercase tracking-wider text-(--color-text) focus:border-(--color-accent) focus:outline-none focus:ring-0"
          placeholder="#RRGGBB"
          maxLength={7}
          aria-label="Hex color"
        />
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] tabular-nums text-(--color-text-faint)">
          {String(value.r).padStart(3, "0")}·{String(value.g).padStart(3, "0")}
          ·{String(value.b).padStart(3, "0")}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => {
          const rgb = hexToRgb(preset.hex);
          if (!rgb) return null;
          const active =
            rgb.r === value.r && rgb.g === value.g && rgb.b === value.b;
          return (
            <button
              key={preset.hex}
              type="button"
              onClick={() => onChange(rgb)}
              className={[
                "relative h-4 w-4 border transition",
                active
                  ? "border-(--color-text)"
                  : "border-(--color-border) hover:border-(--color-border-strong)",
              ].join(" ")}
              style={{ backgroundColor: preset.hex }}
              title={`${preset.label} ${preset.hex}`}
              aria-label={`Pick ${preset.hex}`}
            >
              {active ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 ring-1 ring-(--color-text)/60"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
