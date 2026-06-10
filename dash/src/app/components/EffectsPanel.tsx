"use client";

import { MicroLabel, PixelValue } from "@/app/components/ui";

/** Single source of truth: at/above this length the marquee is
 * auto-enabled (a static message this long won't fit the panel).
 * page.tsx imports this so the force-enable threshold can't drift. */
export const FORCE_ENABLE_MARQUEE_LENGTH = 12;
const MAX_SPEED = 50;

export type EffectsState = {
  marqueeSpeed: number;
};

export function EffectsPanel({
  value,
  onChange,
  messageLength,
  autoForcedSpeed = 10,
}: {
  value: EffectsState;
  onChange: (e: EffectsState) => void;
  messageLength: number;
  /** Speed the page substitutes on the wire when the marquee is
   * auto-forced but the stored speed is still 0. Must match the
   * page's AUTO_FORCED_DEFAULT so the readout shows what transmits. */
  autoForcedSpeed?: number;
}) {
  const isForced = messageLength >= FORCE_ENABLE_MARQUEE_LENGTH;
  const min = isForced ? 1 : 0;
  // Forced + stored 0 means the page transmits `autoForcedSpeed`, so
  // that's what we display — clamping to `min` showed 01 while the
  // wire carried 10. Other below-min values still clamp defensively.
  const displayValue = isForced
    ? value.marqueeSpeed === 0
      ? autoForcedSpeed
      : Math.max(value.marqueeSpeed, min)
    : value.marqueeSpeed;
  const pct = ((displayValue - min) / (MAX_SPEED - min)) * 100;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <MicroLabel>marquee</MicroLabel>
        <span
          className={[
            "flex items-baseline gap-1 font-mono text-[10px] uppercase tracking-[0.2em]",
            isForced ? "text-(--color-amber)" : "text-(--color-text-faint)",
          ].join(" ")}
        >
          {isForced ? <span>auto-forced ·</span> : null}
          <PixelValue>{String(displayValue).padStart(2, "0")}</PixelValue>
          <span>px·step⁻¹</span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          {isForced ? "min" : "off"}
        </span>
        <input
          type="range"
          min={min}
          max={MAX_SPEED}
          value={displayValue}
          onChange={(e) => onChange({ marqueeSpeed: Number(e.target.value) })}
          className="fader flex-1"
          style={
            { ["--fader-pos" as string]: `${pct}%` } as React.CSSProperties
          }
          aria-label="Marquee speed"
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          fast
        </span>
      </div>
    </div>
  );
}
