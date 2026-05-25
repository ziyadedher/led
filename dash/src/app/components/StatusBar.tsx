"use client";

import { entries } from "@/utils/actions";
import { isOffline, relativeTime } from "@/utils/offline";

/**
 * Bottom diagnostics strip — pinned to the bottom of the viewport.
 * Reads like an IDE / DAW status bar: target on the left, mode +
 * queue + heartbeat + state on the right, all in a single row of
 * fixed-height cells separated by hairlines.
 *
 * Receives the active-panel slice already resolved by `page.tsx` so
 * it can render in any session (no panels, offline, paused).
 */
export function StatusBar({
  panelName,
  panelMode,
  driverVersion,
  isPanelPaused,
  lastSeen,
  panelId,
  now,
}: {
  panelName: string | null;
  panelMode: string | null;
  driverVersion: string | null;
  isPanelPaused: boolean;
  lastSeen: string | null;
  panelId: string;
  now: number;
}) {
  const offline = isOffline(lastSeen, now);
  const queueDepth = useQueueDepth(panelId);
  const versionShort = driverVersion ? driverVersion.slice(0, 10) : "—";

  // Each state carries a non-color glyph in addition to its hue and
  // the (optional) animated lamp, so paused/offline/transmitting stay
  // distinguishable for color-blind users and when the lamp is off.
  const beat = isPanelPaused
    ? {
        label: "paused",
        glyph: "⏸",
        tone: "text-(--color-amber)",
        lampClass: "",
      }
    : offline
      ? {
          label: "offline",
          glyph: "✕",
          tone: "text-(--color-danger)",
          lampClass: "",
        }
      : {
          label: "transmitting",
          glyph: "●",
          tone: "text-(--color-phosphor)",
          lampClass: "animate-pulse bg-(--color-phosphor)",
        };

  return (
    <footer
      aria-label="Diagnostics"
      className="bezel-recessed fixed inset-x-0 bottom-0 z-30 border-t border-(--color-border) bg-(--color-surface)"
    >
      <div className="mx-auto flex h-7 max-w-6xl items-stretch divide-x divide-(--color-border) overflow-hidden border-x border-(--color-border)">
        <Cell
          label="target"
          value={panelName ?? "—"}
          className="flex-1 lg:flex-none lg:w-56"
        />
        <Cell label="mode" value={panelMode ?? "—"} accent />
        <Cell
          label="state"
          value={beat.label}
          valueClass={beat.tone}
          // role="status" makes this a valid aria-live region (a bare
          // div + aria-label is aria-prohibited). The visible "state"
          // label + value carry the accessible name, so it announces
          // once — no aria-label needed (which would double-announce).
          role="status"
          prefix={
            <span aria-hidden className="mr-1 leading-none">
              {beat.glyph}
            </span>
          }
          suffix={
            beat.lampClass ? (
              <span
                aria-hidden
                className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full ${beat.lampClass}`}
              />
            ) : null
          }
        />
        {/* Tier 2: hide on small viewports */}
        <Cell
          label="queue"
          value={pad(queueDepth)}
          className="hidden md:flex"
          mono
        />
        <Cell
          label="last seen"
          value={relativeTime(lastSeen, now)}
          className="hidden md:flex"
          muted
        />
        <Cell
          label="driver"
          value={versionShort}
          className="hidden lg:flex"
          muted
          mono
        />

        <span aria-hidden className="hidden flex-1 md:block" />
      </div>
    </footer>
  );
}

function Cell({
  label,
  value,
  valueClass,
  accent,
  muted,
  mono,
  prefix,
  suffix,
  role,
  className,
}: {
  label: string;
  value: string;
  valueClass?: string;
  accent?: boolean;
  muted?: boolean;
  /** When true, render value in mono (raw) instead of pixel font. */
  mono?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  /** ARIA role for the cell (e.g. "status" for the live state cell).
   * The visible label + value carry the accessible name, so no
   * aria-label is set — that would double-announce. */
  role?: React.AriaRole;
  className?: string;
}) {
  return (
    <div
      role={role}
      className={[
        "flex items-center gap-2 px-3",
        className ?? "",
      ].join(" ")}
    >
      <span
        className="font-mono text-[9px] leading-none uppercase tracking-[0.3em] text-(--color-text-dim)"
      >
        {label}
      </span>
      <span
        className={[
          "flex items-center min-w-0 truncate leading-none tabular-nums",
          accent
            ? "text-(--color-accent) uppercase"
            : muted
              ? "text-(--color-text-muted)"
              : valueClass ?? "text-(--color-text)",
        ].join(" ")}
        style={
          mono || muted
            ? {
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.05em",
              }
            : {
                fontFamily: "var(--font-pixel)",
                fontSize: 14,
                letterSpacing: "0.02em",
              }
        }
      >
        {prefix}
        <span className="truncate">{value}</span>
        {suffix}
      </span>
    </div>
  );
}

function useQueueDepth(panelId: string) {
  const { data } = entries.get.useSWR(panelId);
  return data?.entries.length ?? 0;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}
