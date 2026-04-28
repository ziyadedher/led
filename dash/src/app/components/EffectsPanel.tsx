"use client";

const FORCE_MARQUEE_THRESHOLD = 12;

export type EffectsState = {
  marqueeSpeed: number;
};

const MAX_SPEED = 50;

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
  const pct = (value.marqueeSpeed / MAX_SPEED) * 100;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          {"// marquee"}
        </span>
        <span
          className={[
            "font-mono text-[10px] uppercase tracking-[0.2em] tabular-nums",
            isForced && value.marqueeSpeed === 0
              ? "text-(--color-amber)"
              : "text-(--color-text-faint)",
          ].join(" ")}
        >
          {isForced && value.marqueeSpeed === 0
            ? "auto-forced /len>11"
            : `${String(value.marqueeSpeed).padStart(2, "0")} px·step⁻¹`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          off
        </span>
        <input
          type="range"
          min={0}
          max={MAX_SPEED}
          value={value.marqueeSpeed}
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
