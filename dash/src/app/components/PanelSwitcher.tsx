"use client";

import { useEffect, useMemo, useState } from "react";

import { panels } from "@/utils/actions";

// 3× the driver's 30s heartbeat — gives one full miss of breathing
// room before flagging offline. Bigger than this and stale panels
// linger in green; smaller and a single packet loss flaps the badge.
export const OFFLINE_THRESHOLD_MS = 90_000;

type VersionState = "current" | "stale" | "dirty" | "unreported";

export function isOffline(lastSeen: string | null | undefined, now: number): boolean {
  if (!lastSeen) return true;
  const ts = Date.parse(lastSeen);
  if (Number.isNaN(ts)) return true;
  return now - ts > OFFLINE_THRESHOLD_MS;
}

/** Derive each panel's version state relative to the rest of the fleet. */
function classifyVersions(versions: (string | null)[]): VersionState[] {
  // Strip dirty markers so a single dirty deploy doesn't poison the
  // canonical-version calculation across the fleet.
  const cleanVersions = versions.filter(
    (v): v is string => v != null && !v.endsWith("-dirty"),
  );

  // Pick the most-frequently-reported clean version as canonical.
  // Ties resolve on first-seen, which is fine — the goal is just to
  // flag panels running something *different*.
  const counts: Record<string, number> = {};
  for (const v of cleanVersions) counts[v] = (counts[v] ?? 0) + 1;
  let canonical: string | null = null;
  let best = 0;
  for (const [v, c] of Object.entries(counts)) {
    if (c > best) {
      best = c;
      canonical = v;
    }
  }

  return versions.map((v) => {
    if (v == null) return "unreported";
    if (v.endsWith("-dirty")) return "dirty";
    if (canonical && v !== canonical) return "stale";
    return "current";
  });
}

export function PanelSwitcher({
  panelId,
  onChange,
}: {
  panelId: string;
  onChange: (id: string) => void;
}) {
  const { data, error } = panels.get.useSWR();
  const list = useMemo(() => data ?? [], [data]);
  const versionStates = useMemo(
    () => classifyVersions(list.map((p) => p.driver_version)),
    [list],
  );

  // Tick `now` every 5s so the offline badge updates without
  // requiring a fresh data pull.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-2 font-mono text-[11px]">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-[0.3em] text-(--color-text-dim)">
          :: target
        </span>
        <span className="text-(--color-text-faint)">
          {list.length.toString().padStart(2, "0")}
        </span>
      </div>

      {error ? (
        <div className="rounded border border-(--color-danger)/40 bg-(--color-danger)/5 px-2 py-1.5 text-(--color-danger)">
          err: panel index unreachable
        </div>
      ) : null}

      {!error && list.length === 0 ? (
        <div className="rounded border border-dashed border-(--color-border) px-2 py-1.5 text-(--color-text-dim)">
          no panels registered
        </div>
      ) : null}

      <div role="tablist" aria-label="Panel" className="flex flex-col gap-px">
        {list.map((p, i) => {
          const active = p.id === panelId;
          const versionState = versionStates[i];
          const offline = isOffline(p.last_seen, now);
          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(p.id)}
              className={[
                "group flex flex-col gap-0.5 px-2 py-1.5 text-left transition-colors",
                active
                  ? offline
                    ? "bg-(--color-danger)/10 text-(--color-danger)"
                    : "bg-(--color-accent)/10 text-(--color-accent)"
                  : offline
                    ? "text-(--color-text-faint) hover:bg-(--color-surface-2)"
                    : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
              ].join(" ")}
              title={p.description ?? p.name}
            >
              <span className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className={[
                    "shrink-0 font-mono",
                    active
                      ? offline
                        ? "text-(--color-danger)"
                        : "text-(--color-accent)"
                      : "text-(--color-text-faint)",
                  ].join(" ")}
                >
                  {active ? "▸" : " "}
                </span>
                <span
                  aria-hidden
                  className="shrink-0 text-(--color-text-faint) tabular-nums"
                >
                  {(i + 1).toString().padStart(2, "0")}
                </span>
                <span
                  className={[
                    "min-w-0 flex-1 truncate lowercase tracking-wide",
                    offline ? "line-through opacity-60" : "",
                  ].join(" ")}
                >
                  {p.name}
                </span>
                {active && !offline ? (
                  <span className="shrink-0 text-(--color-accent)/70">●</span>
                ) : null}
                {offline ? (
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-danger)/80">
                    offline
                  </span>
                ) : null}
              </span>
              <VersionTag
                version={p.driver_version}
                state={versionState}
                indent={!active}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function VersionTag({
  version,
  state,
  indent,
}: {
  version: string | null;
  state: VersionState;
  indent: boolean;
}) {
  const tone: Record<VersionState, string> = {
    current: "text-(--color-text-faint)",
    stale: "text-(--color-danger)/80",
    dirty: "text-(--color-amber)/80",
    unreported: "text-(--color-text-faint)/60",
  };
  const label: Record<VersionState, string> = {
    current: "v",
    stale: "stale",
    dirty: "dirty",
    unreported: "—",
  };

  return (
    <span
      className={[
        "flex items-baseline gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em]",
        indent ? "pl-7" : "",
        tone[state],
      ].join(" ")}
    >
      <span>{label[state]}</span>
      <span className="truncate normal-case tabular-nums">
        {version ?? "no report"}
      </span>
    </span>
  );
}
