"use client";

import { MODES } from "./types";

import { panels, type PanelMode } from "@/utils/actions";

/**
 * Segmented mode picker. Switching writes the new mode + an empty
 * mode_config to Supabase; per-mode forms hydrate their own defaults
 * if config is missing/partial.
 */
export function ModeSwitcher({
  panelId,
  current,
}: {
  panelId: string;
  current: PanelMode;
}) {
  return (
    <div className="flex items-center justify-between border border-(--color-border) bg-(--color-surface)/40 p-1">
      {MODES.map((m) => {
        const active = m.id === current;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              if (active) return;
              void panels.setMode.call(panelId, m.id, {});
            }}
            className={[
              "flex flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors",
              active
                ? "bg-(--color-accent)/15 text-(--color-accent)"
                : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
            ].join(" ")}
            title={m.blurb}
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.3em]">
              {m.label}
            </span>
            <span
              className={[
                "font-mono text-[9px] tracking-wide",
                active
                  ? "text-(--color-accent)/70"
                  : "text-(--color-text-faint)",
              ].join(" ")}
            >
              {m.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}
