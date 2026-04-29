"use client";

import { useMemo } from "react";

import { panels } from "@/utils/actions";
import { isOffline, relativeTime } from "@/utils/offline";
import { useNow } from "@/utils/useNow";

type VersionState = "current" | "stale" | "dirty" | "unreported";

type SemverTriple = [number, number, number];

/** Parse a leading `MAJOR.MINOR.PATCH` triple, ignoring any trailing
 * label. Returns `null` for legacy git-SHA versions that don't match
 * the shape — those aren't comparable, so we skip them in the max
 * search and treat them as `current` at classify time. */
function parseSemver(v: string): SemverTriple | null {
  const cleaned = v.replace(/-dirty$/, "");
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a: SemverTriple, b: SemverTriple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Derive each panel's version state relative to the rest of the
 * fleet. `driver_version` is now the package's semver (e.g. "0.3.0"),
 * with an optional `-dirty` suffix when the binary was built from a
 * dirty working tree. Stale = strictly behind the highest semver in
 * the fleet; dirty trumps stale (a dirty binary's version is unknown
 * regardless of the leading semver). */
function classifyVersions(versions: (string | null)[]): VersionState[] {
  // Find the highest non-dirty, parseable semver across the fleet.
  let max: SemverTriple | null = null;
  for (const v of versions) {
    if (v == null || v.endsWith("-dirty")) continue;
    const parsed = parseSemver(v);
    if (parsed && (!max || cmpSemver(parsed, max) > 0)) max = parsed;
  }

  return versions.map((v) => {
    if (v == null) return "unreported";
    if (v.endsWith("-dirty")) return "dirty";
    const parsed = parseSemver(v);
    // Legacy git-SHA versions can't be ordered against semvers, so
    // we don't claim they're stale — show them as-is and let the
    // user reflash if they care.
    if (!parsed || !max) return "current";
    return cmpSemver(parsed, max) < 0 ? "stale" : "current";
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

  // Cheap re-render every 5s so the offline badge rolls over
  // without a fresh data pull.
  const now = useNow(5_000);

  return (
    <div className="flex flex-col gap-2 font-mono text-[11px]">
      <div className="flex items-baseline justify-between border-b border-dashed border-(--color-hairline) pb-1.5">
        <span className="uppercase tracking-[0.3em] text-(--color-text-dim)">
          :: target
        </span>
        <span
          className="text-(--color-text-faint) tabular-nums"
          style={{ fontFamily: "var(--font-pixel)", fontSize: 13 }}
        >
          {list.length.toString().padStart(2, "0")}
        </span>
      </div>

      {error ? (
        <div className="border border-(--color-danger)/40 bg-(--color-danger)/5 px-2 py-1.5 text-[10px] text-(--color-danger)">
          err: panel index unreachable
        </div>
      ) : null}

      {!error && list.length === 0 ? (
        <div className="border border-dashed border-(--color-border) px-2 py-3 text-center text-[10px] text-(--color-text-dim)">
          no panels registered
        </div>
      ) : null}

      <div role="tablist" aria-label="Panel" className="flex flex-col gap-px">
        {list.map((p, i) => {
          const active = p.id === panelId;
          const versionState = versionStates[i];
          const offline = isOffline(p.last_seen, now);
          const heartbeatLabel = `last seen ${relativeTime(p.last_seen, now)}`;
          const tooltip = [
            p.description || p.name,
            heartbeatLabel,
            p.is_paused ? "paused" : null,
          ]
            .filter(Boolean)
            .join(" · ");

          // Status indicator: phosphor lamp for live-active, amber for
          // paused, danger for offline, dim for inactive-online.
          const lamp = p.is_paused
            ? { class: "bg-(--color-amber)", glow: "var(--color-amber)" }
            : offline
              ? { class: "bg-(--color-danger)", glow: "var(--color-danger)" }
              : active
                ? { class: "bg-(--color-accent)", glow: "var(--color-accent)" }
                : { class: "bg-(--color-phosphor)/40", glow: "transparent" };

          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(p.id)}
              className={[
                "group relative flex flex-col gap-0.5 border-l-2 px-2 py-1.5 text-left transition-colors",
                active
                  ? offline
                    ? "border-(--color-danger) bg-(--color-danger)/10 text-(--color-danger)"
                    : "border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)"
                  : "border-transparent text-(--color-text-muted) hover:border-(--color-border-strong) hover:bg-(--color-surface-2) hover:text-(--color-text)",
              ].join(" ")}
              title={tooltip}
            >
              <span className="flex items-center gap-2">
                {/* Channel index — tape-deck preset */}
                <span
                  aria-hidden
                  className="shrink-0 text-(--color-text-faint) tabular-nums"
                  style={{
                    fontFamily: "var(--font-pixel)",
                    fontSize: 12,
                    lineHeight: 1,
                  }}
                >
                  {(i + 1).toString().padStart(2, "0")}
                </span>

                {/* Status lamp */}
                <span
                  aria-hidden
                  className={[
                    "h-1.5 w-1.5 shrink-0 rounded-[1px]",
                    lamp.class,
                    active && !offline && !p.is_paused
                      ? "animate-pulse"
                      : "",
                  ].join(" ")}
                  style={{
                    boxShadow:
                      lamp.glow !== "transparent"
                        ? `0 0 6px ${lamp.glow}`
                        : "none",
                  }}
                />

                {/* Panel name */}
                <span
                  className={[
                    "min-w-0 flex-1 truncate lowercase tracking-wide",
                    offline ? "line-through opacity-60" : "",
                  ].join(" ")}
                >
                  {p.name}
                </span>

                {/* Right-side state chips */}
                {p.is_paused ? (
                  <span
                    aria-label="paused"
                    title={`paused · ${heartbeatLabel}`}
                    className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-amber)/80"
                  >
                    ❚❚
                  </span>
                ) : null}
                {offline ? (
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-danger)/80">
                    offline
                  </span>
                ) : null}
              </span>

              {/* Secondary row — version + heartbeat (only when active
               * or non-current to keep the list quiet by default) */}
              <VersionTag
                version={p.driver_version}
                state={versionState}
                indent
                show={active || versionState !== "current"}
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
  show,
}: {
  version: string | null;
  state: VersionState;
  indent: boolean;
  show: boolean;
}) {
  if (!show) return null;
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
        {version ? version.slice(0, 12) : "no report"}
      </span>
    </span>
  );
}
