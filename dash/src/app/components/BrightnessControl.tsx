"use client";

import { useEffect, useRef } from "react";

import { panels } from "@/utils/actions";
import { useSyncedFromProp } from "@/utils/useSyncedFromProp";

/**
 * Global brightness fader for the active panel — a final 0–100%
 * multiplier the driver applies to every pixel, alongside pause/off.
 * Local state drives the slider for smooth dragging; writes to
 * Supabase are debounced so a drag ships one update per ~200ms, and
 * the local value re-syncs to the server value when the panel changes.
 */
export function BrightnessControl({
  panelId,
  brightness,
  disabled = false,
}: {
  panelId: string;
  brightness: number;
  disabled?: boolean;
}) {
  // Keyed on panelId: resets to the server value when switching
  // panels, but a server echo of the same panel won't fight a drag.
  const [pct, setPct] = useSyncedFromProp(panelId, Math.round(brightness * 100));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onChange = (next: number) => {
    setPct(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void panels.setBrightness.call(panelId, next / 100);
    }, 200);
  };

  return (
    <div
      className="hidden items-center gap-2 border-l border-(--color-border) px-3 py-1.5 md:flex"
      title={`global brightness — ${pct}%`}
    >
      <SunIcon />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Global brightness"
        className="fader w-20"
        style={{ ["--fader-pos" as string]: `${pct}%` }}
      />
      <span className="w-7 text-right font-mono text-[9px] tabular-nums text-(--color-text-faint)">
        {pct}%
      </span>
    </div>
  );
}

function SunIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 text-(--color-accent)"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="3" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
        const a = (deg * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={8 + Math.cos(a) * 5.5}
            y1={8 + Math.sin(a) * 5.5}
            x2={8 + Math.cos(a) * 7}
            y2={8 + Math.sin(a) * 7}
          />
        );
      })}
    </svg>
  );
}
