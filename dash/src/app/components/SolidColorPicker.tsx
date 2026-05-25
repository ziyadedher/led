"use client";

import { useState } from "react";

import { hexToRgb, rgbToHex, type Rgb } from "@/utils/color";

/** Preset swatches wired to the `--color-swatch-*` tokens (globals.css)
 * so the palette stays in one place. The resolved hexes match the
 * token definitions; we keep them here for the rgb comparison + the
 * `value` attribute without a getComputedStyle round-trip. */
const PRESETS = [
  { token: "--color-swatch-rose", hex: "#FF4D6D", label: "rose" },
  { token: "--color-swatch-amber", hex: "#FF8A2C", label: "amber" },
  { token: "--color-swatch-sun", hex: "#FFE066", label: "sun" },
  { token: "--color-swatch-lime", hex: "#A6E22E", label: "lime" },
  { token: "--color-swatch-cyan", hex: "#4DE0E0", label: "cyan" },
  { token: "--color-swatch-azure", hex: "#4DA3FF", label: "azure" },
  { token: "--color-swatch-violet", hex: "#A04DFF", label: "violet" },
  { token: "--color-swatch-white", hex: "#FFFFFF", label: "white" },
];

/**
 * Single-color picker shared across every scene composer that
 * needs to pick one Rgb value (clock, life, shapes, paint, …).
 * The text-mode `ColorPicker` (which adds a rainbow alternative)
 * delegates to this component for its rgb branch — there's exactly
 * one solid-color UX in the dash, in one place.
 *
 * UX: live swatch, hex text input, RGB readout, plus a preset grid.
 * Hex input keeps a draft string so partial typing doesn't fight the
 * parent's value; it only COMMITS on blur or Enter (not on every
 * keystroke that happens to parse) so typing "#FF0" doesn't briefly
 * jump the panel to red.
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

  // Commit the draft if it's a complete, parseable hex; otherwise
  // snap the draft back to the committed value so the field never
  // strands a half-typed string.
  const commitDraft = () => {
    const rgb = hexToRgb(draft);
    if (rgb) {
      onChange(rgb);
    } else {
      setDraft(valueHex);
    }
  };

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
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
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
              key={preset.token}
              type="button"
              onClick={() => onChange(rgb)}
              className={[
                "relative h-4 w-4 border transition",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--color-bg)",
                active
                  ? "border-(--color-text)"
                  : "border-(--color-border) hover:border-(--color-border-strong)",
              ].join(" ")}
              style={{ backgroundColor: `var(${preset.token})` }}
              title={`${preset.label} ${preset.hex}`}
              aria-label={`Pick ${preset.label}`}
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
