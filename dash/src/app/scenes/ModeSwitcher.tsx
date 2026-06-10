"use client";

import {
  Bars3BottomLeftIcon,
  BeakerIcon,
  ChevronDoubleDownIcon,
  ClockIcon,
  CubeTransparentIcon,
  FilmIcon,
  FireIcon,
  LightBulbIcon,
  PaintBrushIcon,
  PhotoIcon,
  SparklesIcon,
  StarIcon,
  SunIcon,
} from "@heroicons/react/24/outline";
import { useRef, useState } from "react";

import { MODES } from "./types";

import { FOCUS_RING } from "@/app/components/ui";
import { panels, type PanelMode } from "@/utils/actions";
import { recallModeConfig, rememberModeConfig } from "@/utils/modeConfigCache";

/**
 * The id of the content region these tabs drive — the per-mode
 * composer section in page.tsx. Each tab's `aria-controls` points
 * here so AT announces the tab/panel relationship. page.tsx must
 * carry the matching `id={MODE_CONTENT_ID}` + `role="tabpanel"` +
 * `aria-labelledby={`mode-tab-${mode}`}`.
 */
export const MODE_CONTENT_ID = "mode-content";

/**
 * Segmented mode picker. The DB stores a single `mode_config` column
 * shared across modes, so naively writing `{}` on every switch wiped
 * the outgoing editor's work. Per-mode configs survive toggles via
 * the shared write-through cache in `@/utils/modeConfigCache`:
 * actions.ts records every config it actually writes (setMode /
 * setModeConfig), so the cache always holds the freshest written
 * value — the SWR snapshot lags by debounce + write RTT +
 * realtime-echo RTT, and restoring from it silently reverted recent
 * edits. On switch we snapshot the server row too; the cache
 * arbitrates by timestamp so whichever is genuinely newer wins.
 * Per-mode forms still hydrate their own defaults if config is
 * missing/partial.
 *
 * Each tile is a "preset key" — heroicon glyph, label, and short
 * blurb. Active tile gets a recessed/illuminated treatment; inactive
 * tiles read as cold keys.
 */
export function ModeSwitcher({
  panelId,
  current,
}: {
  panelId: string;
  current: PanelMode;
}) {
  // Read the live panel row from the SWR cache (already subscribed at
  // the page root) so we can snapshot the OUTGOING mode's config
  // before we switch away from it.
  const { data: allPanels } = panels.get.useSWR();
  const activeRow = allPanels?.find((p) => p.id === panelId);
  const currentConfig =
    (activeRow?.mode_config as Record<string, unknown> | null | undefined) ??
    null;

  // Refs to each tab button, so arrow-key navigation can move DOM
  // focus to the newly-focused tab (roving tabindex pattern).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // ARIA tab pattern, MANUAL ACTIVATION variant: arrows move focus
  // only; Enter/Space (the button's native click) activates. NOT
  // selection-follows-focus — switchTo fires a Supabase write that
  // changes the physical panel, so merely arrowing across the tiles
  // must never activate them. `focusedId` drives the roving tabindex
  // and resyncs to `current` whenever the selected mode changes
  // (render-time adjust, not an effect).
  const [focusedId, setFocusedId] = useState<PanelMode>(current);
  const [prevCurrent, setPrevCurrent] = useState<PanelMode>(current);
  if (prevCurrent !== current) {
    setPrevCurrent(current);
    setFocusedId(current);
  }

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (index + 1) % MODES.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (index - 1 + MODES.length) % MODES.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = MODES.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = MODES[next];
    if (target) {
      setFocusedId(target.id);
      tabRefs.current[next]?.focus();
    }
  };

  const switchTo = (next: PanelMode) => {
    // Snapshot what's currently persisted under the outgoing mode.
    // The cache compares timestamps: a write-through entry from a
    // local write that's FRESHER than the row keeps winning (the SWR
    // snapshot lags by debounce + RTT + echo), but a row that's NEWER
    // than the cached entry — an MCP write, a second tab — replaces
    // it, so switching back can't resurrect a stale config over an
    // external writer's work.
    if (currentConfig && Object.keys(currentConfig).length > 0) {
      // Undefined falls back to "now" inside the cache helper.
      const rowAt = activeRow?.last_updated
        ? Date.parse(activeRow.last_updated)
        : undefined;
      rememberModeConfig(panelId, current, currentConfig, rowAt);
    }
    const restored = recallModeConfig(panelId, next) ?? {};
    void panels.setMode.call(panelId, next, restored);
  };

  return (
    <div
      role="tablist"
      aria-label="Mode"
      className="bezel-recessed relative flex flex-wrap gap-px overflow-hidden border border-(--color-border) bg-(--color-border)"
    >
      {MODES.map((m, i) => {
        const active = m.id === current;
        const Icon = MODE_ICONS[m.id];
        return (
          <button
            key={m.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`mode-tab-${m.id}`}
            aria-selected={active}
            aria-controls={MODE_CONTENT_ID}
            tabIndex={m.id === focusedId ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => {
              if (active) return;
              switchTo(m.id);
            }}
            // Even-rows wrap: each tile takes a slightly-less-than-25%
            // basis (50% on phones, where 4-across crushes the labels
            // to ellipses) so a row of 4 fits exactly even with the
            // 1px gap between tiles, and a trailing row of N<4 grows
            // each tile via flex-grow=1 to fill — 5 tiles → 4+1 (1
            // grows full-width), 6 → 4+2 (each 50%), 7 → 4+3 (each
            // 33%). The same math holds for the 2-across phone grid.
            // `min-w-0` lets tiles actually shrink to their basis
            // instead of pinning to intrinsic content width (default
            // min-width:auto would prevent that).
            className={[
              "group relative isolate flex min-w-0 grow items-stretch gap-2 px-3 py-3 text-left transition-all basis-[calc(50%-1px)] sm:gap-3 sm:px-4 sm:basis-[calc(25%-1px)]",
              FOCUS_RING,
              "focus-visible:ring-inset",
              active
                ? "bg-(--color-bg) text-(--color-accent) shadow-[inset_0_0_24px_-4px_var(--color-accent-fade)]"
                : "bg-(--color-surface)/70 text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
            ].join(" ")}
            title={m.blurb}
          >
            {/* Icon plate */}
            <span
              aria-hidden
              className={[
                "flex h-9 w-9 shrink-0 items-center justify-center self-center border",
                active
                  ? "border-(--color-accent)/60 bg-(--color-accent)/10 text-(--color-accent)"
                  : "border-(--color-border) bg-(--color-bg)/50 text-(--color-text-dim) group-hover:border-(--color-border-strong) group-hover:text-(--color-text)",
              ].join(" ")}
              style={{
                filter: active
                  ? "drop-shadow(0 0 6px var(--color-accent-fade))"
                  : "none",
              }}
            >
              <Icon className="h-4 w-4" strokeWidth={1.6} />
            </span>

            <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
              <span className="truncate font-mono text-[11px] uppercase tracking-[0.3em]">
                {m.label}
              </span>
              <span
                className={[
                  "truncate font-mono text-[9px] tracking-wide",
                  active
                    ? "text-(--color-accent)"
                    : "text-(--color-text-faint)",
                ].join(" ")}
              >
                {m.blurb}
              </span>
            </span>

            {/* Top hairline that lights up on active — reads as "this
             * preset is engaged" */}
            <span
              aria-hidden
              className={[
                "pointer-events-none absolute inset-x-0 top-0 h-px transition-opacity",
                active
                  ? "bg-(--color-accent) opacity-80"
                  : "bg-(--color-border-strong) opacity-0 group-hover:opacity-60",
              ].join(" ")}
            />
          </button>
        );
      })}
    </div>
  );
}

const MODE_ICONS: Record<
  PanelMode,
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  text: Bars3BottomLeftIcon,
  clock: ClockIcon,
  image: PhotoIcon,
  gif: FilmIcon,
  paint: PaintBrushIcon,
  shapes: CubeTransparentIcon,
  life: SparklesIcon,
  plasma: SunIcon,
  fire: FireIcon,
  rain: ChevronDoubleDownIcon,
  starfield: StarIcon,
  lava: LightBulbIcon,
  test: BeakerIcon,
};
