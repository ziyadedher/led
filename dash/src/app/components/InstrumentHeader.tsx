"use client";

import { useMemo } from "react";

import { LiveDot } from "@/app/components/LiveDot";
import { panels, type RealtimeStatus } from "@/utils/actions";
import { isOffline } from "@/utils/offline";
import { useNow } from "@/utils/useNow";

type PanelRow = {
  last_seen: string | null;
  is_paused: boolean | null;
  is_off: boolean | null;
};

/**
 * Top instrument bar. Title plate on the left, fleet telemetry on
 * the right (online count, paused count, realtime channel state).
 * Sits above everything and grounds the page in a "control surface"
 * frame instead of dropping the user straight into the simulator.
 */
export function InstrumentHeader({
  realtimeStatus,
}: {
  realtimeStatus: RealtimeStatus;
}) {
  const { data } = panels.get.useSWR();
  const now = useNow(5_000);

  const stats = useMemo(() => fleetStats(data ?? [], now), [data, now]);

  return (
    <header
      className="bezel-recessed sticky top-0 z-20 -mx-4 mb-4 border-b border-(--color-border) bg-(--color-bg)/90 px-4 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10"
      aria-label="Control surface header"
    >
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-4">
        {/* Identity plate. flex items-center, not items-baseline,
         * because the pixel font has different metrics from the mono
         * tag and would visually drift on baseline alignment. */}
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="select-none leading-none text-(--color-accent)"
            style={{
              fontFamily: "var(--font-pixel)",
              fontSize: 24,
              textShadow:
                "0 0 12px var(--color-accent-fade), 0 0 4px color-mix(in oklch, var(--color-accent) 40%, transparent)",
            }}
          >
            ziyad&apos;s leds
          </span>
        </div>

        <span aria-hidden className="flex-1" />

        {/* Fleet telemetry */}
        <div className="hidden items-stretch gap-px md:flex">
          <Telemetry
            label="online"
            value={`${pad(stats.online)}/${pad(stats.total)}`}
            tone={stats.online === stats.total ? "ok" : "warn"}
          />
          <Telemetry
            label="paused"
            value={pad(stats.paused)}
            tone={stats.paused > 0 ? "warn" : "dim"}
          />
          <Telemetry
            label="off"
            value={pad(stats.off)}
            tone={stats.off > 0 ? "dim" : "dim"}
          />
        </div>

        <div className="flex items-center gap-2 border-l border-(--color-border) pl-4 font-mono text-[9px] leading-none uppercase tracking-[0.3em] text-(--color-text-faint)">
          <span className="hidden lg:inline">realtime</span>
          <LiveDot status={realtimeStatus} />
        </div>
      </div>
    </header>
  );
}

function Telemetry({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "dim";
}) {
  const valueClass = {
    ok: "text-(--color-phosphor)",
    warn: "text-(--color-amber)",
    dim: "text-(--color-text)",
  }[tone];

  return (
    <div className="flex h-8 items-center gap-2 border border-(--color-border) bg-gradient-to-b from-(--color-surface-2)/60 to-(--color-surface)/40 px-3 first:rounded-l-[1px] last:rounded-r-[1px]">
      <span className="font-mono text-[9px] leading-none uppercase tracking-[0.3em] text-(--color-text-faint)">
        {label}
      </span>
      <span
        className={`tabular-nums leading-none ${valueClass}`}
        style={{
          fontFamily: "var(--font-pixel)",
          fontSize: 16,
          letterSpacing: "0.02em",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function fleetStats(rows: PanelRow[], now: number) {
  let online = 0;
  let paused = 0;
  let off = 0;
  for (const r of rows) {
    if (!isOffline(r.last_seen, now)) online += 1;
    if (r.is_paused) paused += 1;
    if (r.is_off) off += 1;
  }
  return { online, paused, off, total: rows.length };
}
