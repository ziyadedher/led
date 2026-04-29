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
 * Segmented mode picker. Switching writes the new mode + an empty
 * mode_config to Supabase; per-mode forms hydrate their own defaults
 * if config is missing/partial.
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
              void panels.setMode.call(panelId, m.id, {});
            }}
            // Even-rows wrap: each tile takes a slightly-less-than-50%
            // (mobile) or 25% (sm+) basis so a row of 2/4 fits
            // exactly even with the 1px gap between tiles, and a
            // trailing row of N<row-size grows each tile via
            // flex-grow=1 to fill. `min-w-0` lets tiles actually
            // shrink to their basis instead of pinning to intrinsic
            // content width (default min-width:auto would prevent
            // that).
            className={[
              "group relative isolate flex min-w-0 grow items-stretch gap-3 px-3 py-2.5 text-left transition-all basis-[calc(50%-1px)] sm:basis-[calc(25%-1px)] sm:px-4 sm:py-3",
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
                    ? "text-(--color-accent)/70"
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
