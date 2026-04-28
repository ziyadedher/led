"use client";

import { useState } from "react";

import { hexToRgb, rgbToHex, type Rgb } from "@/utils/color";

/**
 * Hex `#RRGGBB` text input with a live swatch. Used by the
 * ColorPicker (RGB mode) and the clock + life mode composers.
 *
 * The input keeps a *draft* string so partial typing doesn't snap
 * the value back to the last valid hex. Only commits on a fully-
 * formed 6-digit hex.
 */
export function HexColorInput({
  value,
  onChange,
  className,
}: {
  value: Rgb;
  onChange: (next: Rgb) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(() => rgbToHex(value));
  // Sync down when the parent value changes externally (e.g. preset
  // click). Computed during render — React 19 deduplicates if the
  // resulting state is unchanged.
  const valueHex = rgbToHex(value);
  const [snapshot, setSnapshot] = useState(valueHex);
  if (snapshot !== valueHex) {
    setSnapshot(valueHex);
    setDraft(valueHex);
  }

  return (
    <span className="inline-flex items-center gap-2">
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
        className={
          className ??
          "w-32 border-0 border-b border-(--color-border-strong) bg-transparent p-0 pb-1 font-mono text-base uppercase tracking-wider text-(--color-text) focus:border-(--color-accent) focus:outline-none focus:ring-0"
        }
        placeholder="#RRGGBB"
        maxLength={7}
        aria-label="Hex color"
      />
      <span
        className="inline-block h-5 w-5 border border-(--color-border-strong)"
        style={{
          backgroundColor: valueHex,
          boxShadow: `0 0 12px -2px ${valueHex}`,
        }}
        aria-hidden
      />
    </span>
  );
}
