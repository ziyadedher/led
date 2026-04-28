"use client";

import { MODES } from "./types";

import { panels, type PanelMode } from "@/utils/actions";

/**
 * Segmented mode picker. Switching writes the new mode + an empty
 * mode_config to Supabase; per-mode forms hydrate their own defaults
 * if config is missing/partial.
 *
 * Each button is a "preset key" — large mode glyph, label, and short
 * blurb. Active button gets a recessed/illuminated treatment with
 * the phosphor "ON" lamp; inactive buttons read as cold keys.
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
      className="bezel-recessed relative grid grid-cols-2 gap-px overflow-hidden border border-(--color-border) bg-(--color-border) sm:grid-cols-3 lg:grid-cols-5"
    >
      {MODES.map((m) => {
        const active = m.id === current;
        const glyph = MODE_GLYPHS[m.id];
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
            className={[
              "group relative isolate flex items-stretch gap-3 px-4 py-3 text-left transition-all",
              active
                ? "bg-(--color-bg) text-(--color-accent) shadow-[inset_0_0_24px_-4px_var(--color-accent-fade)]"
                : "bg-(--color-surface)/70 text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
            ].join(" ")}
            title={m.blurb}
          >
            {/* Pixel-font glyph anchor */}
            <span
              aria-hidden
              className={[
                "flex h-9 w-9 shrink-0 items-center justify-center self-center border",
                active
                  ? "border-(--color-accent)/60 bg-(--color-accent)/10 text-(--color-accent)"
                  : "border-(--color-border) bg-(--color-bg)/50 text-(--color-text-dim) group-hover:border-(--color-border-strong) group-hover:text-(--color-text)",
              ].join(" ")}
              style={{
                fontFamily: "var(--font-pixel)",
                fontSize: 22,
                lineHeight: 1,
                textShadow: active
                  ? "0 0 8px var(--color-accent-fade)"
                  : "none",
              }}
            >
              {glyph}
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

const MODE_GLYPHS: Record<PanelMode, string> = {
  text: "≡",
  clock: "◷",
  image: "▦",
  paint: "✎",
  life: "✲",
  test: "▤",
};
