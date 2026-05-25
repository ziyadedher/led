"use client";

import {
  Bars3BottomLeftIcon,
  BeakerIcon,
  ClockIcon,
  CubeTransparentIcon,
  FilmIcon,
  PaintBrushIcon,
  PhotoIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";

import { MODES } from "./types";

import { panels, type PanelMode } from "@/utils/actions";

/**
 * Per-mode config cache, module-scoped so it survives this component's
 * remounts within a session. Keyed by `panelId:mode`. The DB stores a
 * single `mode_config` column shared across modes, so naively writing
 * `{}` on every switch wiped the outgoing editor's work. We instead
 * stash the outgoing mode's config here on switch and restore the
 * incoming mode's last-known config (if we've seen it), so toggling
 * modes back and forth no longer destroys the previous editor's state.
 */
const configCache = new Map<string, Record<string, unknown>>();
const cacheKey = (panelId: string, mode: PanelMode) => `${panelId}:${mode}`;

/**
 * Segmented mode picker. Switching preserves per-mode config across
 * toggles (see `configCache`); per-mode forms still hydrate their own
 * defaults if config is missing/partial.
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
  const currentConfig =
    (allPanels?.find((p) => p.id === panelId)?.mode_config as
      | Record<string, unknown>
      | null
      | undefined) ?? null;

  const switchTo = (next: PanelMode) => {
    // Snapshot what's currently persisted under the outgoing mode so a
    // later switch back restores it rather than the empty default.
    if (currentConfig && Object.keys(currentConfig).length > 0) {
      configCache.set(cacheKey(panelId, current), currentConfig);
    }
    const restored = configCache.get(cacheKey(panelId, next)) ?? {};
    void panels.setMode.call(panelId, next, restored);
  };

  return (
    <div
      role="tablist"
      aria-label="Mode"
      className="bezel-recessed relative flex flex-wrap gap-px overflow-hidden border border-(--color-border) bg-(--color-border)"
    >
      {MODES.map((m) => {
        const active = m.id === current;
        const Icon = MODE_ICONS[m.id];
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (active) return;
              switchTo(m.id);
            }}
            // Even-rows wrap: each tile takes a slightly-less-than-25%
            // basis so a row of 4 fits exactly even with the
            // 1px gap between tiles, and a trailing row of N<4 grows
            // each tile via flex-grow=1 to fill — 5 tiles → 4+1 (1
            // grows full-width), 6 → 4+2 (each 50%), 7 → 4+3 (each
            // 33%). `min-w-0` lets tiles actually shrink to their
            // basis instead of pinning to intrinsic content width
            // (default min-width:auto would prevent that).
            className={[
              "group relative isolate flex min-w-0 grow items-stretch gap-3 px-4 py-3 text-left transition-all basis-[calc(25%-1px)]",
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
  test: BeakerIcon,
};
