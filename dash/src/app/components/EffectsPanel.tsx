"use client";

const FORCE_MARQUEE_THRESHOLD = 12;
const MAX_SPEED = 50;

export type EffectsState = {
  marqueeSpeed: number;
};

export function EffectsPanel({
  value,
  onChange,
  messageLength,
}: {
  value: EffectsState;
  onChange: (e: EffectsState) => void;
  messageLength: number;
}) {
  const isForced = messageLength >= FORCE_MARQUEE_THRESHOLD;
  const min = isForced ? 1 : 0;
  // Defensive: never render below `min`.
  const displayValue = isForced ? Math.max(value.marqueeSpeed, min) : value.marqueeSpeed;
  const pct = ((displayValue - min) / (MAX_SPEED - min)) * 100;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          {"// marquee"}
        </span>
        <span
          className={[
            "font-mono text-[10px] uppercase tracking-[0.2em] tabular-nums",
            isForced ? "text-(--color-amber)" : "text-(--color-text-faint)",
          ].join(" ")}
        >
          {isForced ? "auto-forced · " : ""}
          {String(displayValue).padStart(2, "0")} px·step⁻¹
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

export const FORCE_ENABLE_MARQUEE_LENGTH = FORCE_MARQUEE_THRESHOLD;
