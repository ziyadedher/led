"use client";

import { FOCUS_RING, MicroLabel, PixelValue } from "./ui";

/**
 * Shared labeled slider. Replaces the hand-rolled `pct` slider +
 * preset-chip rows duplicated across shapes / gif / life. The native
 * `<input type=range>` carries the keyboard model (arrows step, the
 * thumb takes focus) so this is keyboard-operable for free; the
 * `.fader` class (globals.css) draws the LED-orange filled track.
 *
 * `label` is plain text — the `::` sigil is rendered here so callers
 * can't drift the prefix. `presets` renders snap chips below the
 * slider. `format` controls the right-aligned value readout;
 * `endpoints` labels the slider extremes (e.g. slow/fast, wire/solid).
 */
export function Fader({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format = (v) => v.toFixed(2),
  endpoints,
  presets,
  presetLabel = (v) => `${v}`,
  ariaLabel,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  /** Right-aligned readout of the current value. */
  format?: (v: number) => string;
  /** Labels for the slider extremes, e.g. ["slow", "fast"]. */
  endpoints?: [string, string];
  /** Snap-to values rendered as chips below the slider. */
  presets?: number[];
  /** Chip text for a preset value. */
  presetLabel?: (v: number) => string;
  ariaLabel?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <MicroLabel>{label}</MicroLabel>
        <PixelValue className="text-(--color-text)">{format(value)}</PixelValue>
      </div>

      <div className="flex items-center gap-3">
        {endpoints ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
            {endpoints[0]}
          </span>
        ) : null}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="fader flex-1"
          style={{ ["--fader-pos" as string]: `${pct}%` } as React.CSSProperties}
          aria-label={ariaLabel ?? label}
        />
        {endpoints ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
            {endpoints[1]}
          </span>
        ) : null}
      </div>

      {presets && presets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {presets.map((p) => {
            const active = Math.abs(value - p) < 0.01;
            return (
              <button
                key={p}
                type="button"
                onClick={() => onChange(p)}
                className={[
                  "border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.25em] transition-colors",
                  FOCUS_RING,
                  active
                    ? "border-(--color-accent) bg-(--color-accent)/15 text-(--color-accent)"
                    : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)",
                ].join(" ")}
              >
                {presetLabel(p)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
