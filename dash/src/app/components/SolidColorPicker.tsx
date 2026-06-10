"use client";

import { useEffect, useRef, useState } from "react";

import { FOCUS_RING } from "@/app/components/ui";
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
  // Native-picker draft: browsers fire `input` continuously while the
  // user drags inside the OS color dialog. Committing each of those to
  // the parent would ship one write per drag-frame (paint mode
  // persists a full bitmap per commit), so the dialog edits a local
  // draft and we commit once on the native `change` event — which
  // fires when the dialog is dismissed.
  const [pickerDraft, setPickerDraft] = useState(valueHex);
  const [snapshot, setSnapshot] = useState(valueHex);
  if (snapshot !== valueHex) {
    setSnapshot(valueHex);
    setDraft(valueHex);
    setPickerDraft(valueHex);
  }

  const pickerRef = useRef<HTMLInputElement>(null);
  // Latest-callback ref so the one-time native listener below never
  // closes over a stale onChange. (Synced in an effect — ref writes
  // don't belong in the render body.)
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    const el = pickerRef.current;
    if (!el) return;
    // React's onChange maps to `input`; the dismissal-commit semantics
    // live on the native `change` event, so wire it directly.
    const commit = () => {
      const rgb = hexToRgb(el.value);
      if (rgb) onChangeRef.current(rgb);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);

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
        {/* The swatch doubles as the native color-picker trigger — the
         * only practical color entry on mobile, where typing hex into
         * a caps-tracked field is miserable. The input is sr-only, so
         * its keyboard focus is surfaced on the label via focus-within
         * (otherwise tabbing here is an invisible stop). */}
        <label className="cursor-pointer focus-within:ring-1 focus-within:ring-(--color-accent) focus-within:ring-offset-1 focus-within:ring-offset-(--color-bg)">
          <span
            className="inline-block h-5 w-5 shrink-0 border border-(--color-border-strong)"
            style={{
              backgroundColor: pickerDraft,
              boxShadow: `0 0 10px -2px ${pickerDraft}`,
            }}
            aria-hidden
          />
          <input
            ref={pickerRef}
            type="color"
            value={pickerDraft}
            onChange={(e) => setPickerDraft(e.target.value)}
            className="sr-only"
            aria-label="Open color picker"
          />
        </label>
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
          autoCapitalize="characters"
          autoComplete="off"
          inputMode="text"
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

      {/* Buttons are 24×24 hit areas around 16px painted squares —
       * the packed-16px grid guaranteed mis-taps on touch. */}
      <div className="flex flex-wrap gap-1.5">
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
              className={`group flex h-6 w-6 items-center justify-center ${FOCUS_RING}`}
              title={`${preset.label} ${preset.hex}`}
              aria-label={`Pick ${preset.label}`}
            >
              <span
                aria-hidden
                className={[
                  "relative block h-4 w-4 border transition",
                  active
                    ? "border-(--color-text)"
                    : "border-(--color-border) group-hover:border-(--color-border-strong)",
                ].join(" ")}
                style={{ backgroundColor: `var(${preset.token})` }}
              >
                {active ? (
                  <span className="pointer-events-none absolute inset-0 ring-1 ring-(--color-text)/60" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
