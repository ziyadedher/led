"use client";

import type { RealtimeStatus } from "@/utils/actions";

const PRESETS: Record<
  RealtimeStatus,
  { color: string; glow: string; label: string; glyph: string; sr: string }
> = {
  live: {
    color: "var(--color-phosphor)",
    glow: "var(--color-phosphor)",
    label: "live",
    // Filled circle: a steady, present signal.
    glyph: "●",
    sr: "realtime channel live",
  },
  connecting: {
    color: "var(--color-amber)",
    glow: "var(--color-amber)",
    label: "boot",
    // Ellipsis: mid-handshake / connecting.
    glyph: "…",
    sr: "realtime channel connecting",
  },
  down: {
    color: "var(--color-danger)",
    glow: "var(--color-danger)",
    label: "down",
    // Multiplication sign: channel dropped.
    glyph: "✕",
    sr: "realtime channel down",
  },
};

/**
 * Realtime status indicator. Reflects the actual Supabase channel
 * subscription state (connecting → live, or down on error/timeout).
 * Phosphor-green dot when subscribed; amber while joining; warm red
 * if the channel dropped.
 *
 * State is conveyed three ways so it survives color-blindness and the
 * lamp being decorative: a per-state glyph, the always-present text
 * label, and an explicit accessible name on the wrapper.
 */
export function LiveDot({ status }: { status: RealtimeStatus }) {
  const preset = PRESETS[status];
  return (
    <span
      role="status"
      aria-label={preset.sr}
      className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em]"
      style={{ color: preset.color }}
    >
      <span
        aria-hidden
        className="relative inline-flex h-2 w-2 items-center justify-center"
      >
        {status === "live" ? (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50"
            style={{ background: preset.color }}
          />
        ) : null}
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-[1px]"
          style={{
            background: preset.color,
            boxShadow: `0 0 8px ${preset.glow}`,
          }}
        />
      </span>
      {/* Non-color cue: a glyph that differs per state, so the three
       * states are distinguishable without relying on hue. */}
      <span aria-hidden className="leading-none">
        {preset.glyph}
      </span>
      <span aria-hidden>{preset.label}</span>
    </span>
  );
}
