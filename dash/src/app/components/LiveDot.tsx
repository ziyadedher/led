"use client";

import type { RealtimeStatus } from "@/utils/actions";

const PRESETS: Record<
  RealtimeStatus,
  { color: string; glow: string; label: string }
> = {
  live: {
    color: "var(--color-phosphor)",
    glow: "var(--color-phosphor)",
    label: "live",
  },
  connecting: {
    color: "var(--color-amber)",
    glow: "var(--color-amber)",
    label: "boot",
  },
  down: {
    color: "var(--color-danger)",
    glow: "var(--color-danger)",
    label: "down",
  },
};

/**
 * Realtime status indicator. Reflects the actual Supabase channel
 * subscription state (connecting → live, or down on error/timeout).
 * Phosphor-green dot when subscribed; amber while joining; warm red
 * if the channel dropped.
 */
export function LiveDot({ status }: { status: RealtimeStatus }) {
  const preset = PRESETS[status];
  return (
    <span
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
      <span>{preset.label}</span>
    </span>
  );
}
