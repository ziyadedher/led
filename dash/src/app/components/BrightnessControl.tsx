"use client";

import { useEffect, useRef, useState } from "react";

import { panels } from "@/utils/actions";
import { useSyncedFromProp } from "@/utils/useSyncedFromProp";

/**
 * Global brightness fader for the active panel — a final 0–100%
 * multiplier the driver applies to every pixel, alongside pause/off.
 * Local state drives the slider for smooth dragging; writes to
 * Supabase are debounced so a drag ships one update per ~200ms. The
 * local value resets on panel switch and re-syncs when the server
 * value changes out from under us (another client / MCP call) — but
 * not when the change is just the optimistic echo of our own write.
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
  const serverPct = Math.round(brightness * 100);

  // Keyed on panelId: resets to the server value when switching
  // panels, but a server echo of the same panel won't fight a drag.
  const [pct, setPct] = useSyncedFromProp(panelId, serverPct);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest slider value + the panel it was edited against, so the
  // unmount flush ships the right write even after a panel switch.
  const pendingRef = useRef(serverPct);
  const panelIdRef = useRef(panelId);
  // Last value the debounce actually wrote — lets us tell "server
  // echoed our own write" apart from "someone else moved the fader".
  const lastWrittenRef = useRef<number | null>(null);

  // Remote-change resync, done during render (the React 19 adjust
  // pattern, same as useSyncedFromProp). When the server value moves:
  // always take the snapshot; additionally snap the slider, but only
  // if no write is in flight (a drag isn't being raced) and the new
  // value isn't the echo of our own debounced write.
  const [serverSnapshot, setServerSnapshot] = useState(serverPct);
  if (serverPct !== serverSnapshot) {
    setServerSnapshot(serverPct);
    // The refs here are write-coordination bookkeeping, not render
    // inputs — they only gate whether we *also* snap the slider, and
    // a wrong guess self-heals on the next server value. Reading them
    // in render is deliberate; the lint can't know that.
    // eslint-disable-next-line react-hooks/refs
    if (timerRef.current == null && serverPct !== lastWrittenRef.current) {
      setPct(serverPct);
    }
  }

  // Echo consumed — clear the suppression (after render; ref writes
  // don't belong in the render body) so a LATER remote change back to
  // this same value (round numbers recur) isn't mistaken for our own
  // write forever.
  useEffect(() => {
    if (lastWrittenRef.current === serverPct) {
      lastWrittenRef.current = null;
    }
  }, [serverPct]);

  // Unmount: don't drop a trailing write — flush the pending value to
  // the panel it was edited against.
  useEffect(
    () => () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        void panels.setBrightness.call(
          panelIdRef.current,
          pendingRef.current / 100,
        );
      }
    },
    [],
  );

  const onChange = (next: number) => {
    setPct(next);
    pendingRef.current = next;
    // A new edit targeting a different panel invalidates any echo
    // bookkeeping from the previous one.
    if (panelIdRef.current !== panelId) lastWrittenRef.current = null;
    panelIdRef.current = panelId;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastWrittenRef.current = next;
      void panels.setBrightness.call(panelId, next / 100);
    }, 200);
  };

  return (
    <div
      // Paints its own cell background: SectionPlate divides cells via
      // gap-px hairlines, not per-cell borders (wrap-safe).
      className="flex items-center gap-2 bg-gradient-to-b from-(--color-surface-2) to-(--color-surface) px-3 py-1.5"
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
        className="fader w-16 md:w-20"
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
