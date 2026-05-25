"use client";

import { PowerIcon } from "@heroicons/react/24/outline";
import { useMemo, useRef } from "react";

import { panels } from "@/utils/actions";
import { isOffline, relativeTime } from "@/utils/offline";
import { useNow } from "@/utils/useNow";

/**
 * The id of the content region these tabs drive — the matrix
 * simulator section in page.tsx. Each tab's `aria-controls` points
 * here so AT announces the tab/panel relationship. page.tsx must
 * carry the matching `id={PANEL_CONTENT_ID}` + `role="tabpanel"`.
 */
export const PANEL_CONTENT_ID = "panel-content";

type VersionState = "current" | "stale" | "dirty" | "legacy" | "unreported";

type SemverTriple = [number, number, number];

/** Parse a leading `MAJOR.MINOR.PATCH` triple, ignoring any trailing
 * label. Returns `null` for legacy git-SHA versions that don't match
 * the shape — those aren't comparable, so we skip them in the max
 * search and flag them as `legacy` (not `current`) at classify time
 * so a stale old build can't masquerade as up-to-date. */
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
    // Legacy git-SHA (or otherwise non-semver) versions can't be
    // ordered against semvers. Don't silently call them `current` —
    // a stale old build would masquerade as up-to-date. Surface them
    // as `legacy` so the user knows the version is unverified.
    if (!parsed) return "legacy";
    // No parseable fleet-max to compare against → can't prove stale.
    if (!max) return "current";
    return cmpSemver(parsed, max) < 0 ? "stale" : "current";
  });
}

/** Short human label for a panel's operational state, used for both
 * the visible chip and the consolidated accessible name. Mirrors the
 * lamp priority: offline (truth check) → off → paused → live. */
function stateLabel(p: {
  is_off: boolean;
  is_paused: boolean;
}): "offline" | "off" | "paused" | "live" {
  return p.is_off ? "off" : p.is_paused ? "paused" : "live";
}

/** Trailing version clause for the accessible name. Keeps state out
 * of color alone — every distinction is also spelled in text. */
function versionClause(version: string | null, state: VersionState): string {
  switch (state) {
    case "unreported":
      return "version not reported";
    case "legacy":
      return version ? `legacy build ${version}` : "legacy build";
    case "dirty":
      return version ? `dirty build ${version}` : "dirty build";
    case "stale":
      return version ? `stale, driver ${version}` : "stale";
    case "current":
      return version ? `driver ${version}` : "driver up to date";
  }
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

  // Refs to each tab button, so arrow-key navigation can move DOM
  // focus to the newly-selected tab (roving tabindex pattern).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Cheap re-render every 5s so the offline badge rolls over
  // without a fresh data pull.
  const now = useNow(5_000);

  // ARIA tab pattern: arrow keys move selection (and focus) between
  // tabs; Home/End jump to the ends. Selection follows focus, which
  // matches a single-content-region switcher.
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (index + 1) % list.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (index - 1 + list.length) % list.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = list.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = list[next];
    if (target) {
      onChange(target.id);
      tabRefs.current[next]?.focus();
    }
  };

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
          // `offline` is a derived liveness truth-check that overrides
          // the panel's reported on/off/paused state in the label.
          const state = offline ? "offline" : stateLabel(p);
          const tooltip = [
            p.description || p.name,
            heartbeatLabel,
            p.is_off ? "off" : null,
            p.is_paused ? "paused" : null,
          ]
            .filter(Boolean)
            .join(" · ");

          // One clean accessible name per tab: "<name> — <state>,
          // <version clause>". State is always spelled out (never
          // color-only); offline drops the version clause as moot.
          const accessibleName = offline
            ? `${p.name} — offline, ${heartbeatLabel}`
            : `${p.name} — ${state}, ${versionClause(p.driver_version, versionState)}`;

          // Status indicator: phosphor lamp for live-active, dim for
          // off, amber for paused, danger for offline, dim for
          // inactive-online. Offline takes priority (truth check),
          // then off (user explicitly killed it), then paused.
          const lamp = offline
            ? { class: "bg-(--color-danger)", glow: "var(--color-danger)" }
            : p.is_off
              ? { class: "bg-(--color-text-faint)", glow: "transparent" }
              : p.is_paused
                ? { class: "bg-(--color-amber)", glow: "var(--color-amber)" }
                : active
                  ? { class: "bg-(--color-accent)", glow: "var(--color-accent)" }
                  : { class: "bg-(--color-phosphor)/40", glow: "transparent" };

          return (
            <button
              key={p.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              type="button"
              id={`panel-tab-${p.id}`}
              aria-selected={active}
              aria-controls={PANEL_CONTENT_ID}
              aria-label={accessibleName}
              tabIndex={active ? 0 : -1}
              onKeyDown={(e) => onKeyDown(e, i)}
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
                    active && !offline && !p.is_paused && !p.is_off
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

                {/* Right-side state chips. Decorative — the tab's
                 * `aria-label` carries the canonical state, so these
                 * are hidden from AT to avoid a muddy double-read. */}
                {p.is_off ? (
                  <PowerIcon
                    aria-hidden
                    className="h-3 w-3 shrink-0 text-(--color-text-faint)"
                  />
                ) : null}
                {p.is_paused ? (
                  <span
                    aria-hidden
                    className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-amber)/80"
                  >
                    ❚❚
                  </span>
                ) : null}
                {offline ? (
                  <span
                    aria-hidden
                    className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-danger)/80"
                  >
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
    legacy: "text-(--color-amber)/80",
    unreported: "text-(--color-text-faint)/60",
  };
  const label: Record<VersionState, string> = {
    current: "v",
    stale: "stale",
    dirty: "dirty",
    legacy: "legacy",
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
