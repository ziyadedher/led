"use client";

const FORCE_MARQUEE_THRESHOLD = 12;

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

  return (
    <div className="space-y-3 rounded-xl border border-[--color-border] bg-[--color-surface-2] p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[--color-text-dim]">
          marquee
        </span>
        {isForced ? (
          <span className="font-mono text-[10px] text-[--color-accent]">
            auto-on (long message)
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-3 font-mono text-xs text-[--color-text-muted]">
        <span>off</span>
        <input
          type="range"
          min={0}
          max={50}
          value={value.marqueeSpeed}
          onChange={(e) =>
            onChange({ marqueeSpeed: Number(e.target.value) })
          }
          className="flex-1 accent-[--color-accent]"
        />
        <span>fast</span>
        <span className="w-8 text-right tabular-nums text-[--color-text]">
          {value.marqueeSpeed}
        </span>
      </div>
    </div>
  );
}

export const FORCE_ENABLE_MARQUEE_LENGTH = FORCE_MARQUEE_THRESHOLD;
