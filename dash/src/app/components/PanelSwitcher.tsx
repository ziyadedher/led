"use client";

import { useMemo } from "react";

import { panels } from "@/utils/actions";

export function PanelSwitcher({
  panelId,
  onChange,
}: {
  panelId: string;
  onChange: (id: string) => void;
}) {
  const { data, error } = panels.get.useSWR();
  const list = useMemo(() => data ?? [], [data]);

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
          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(p.id)}
              className={[
                "group flex items-center gap-2.5 px-2 py-1.5 text-left transition-colors",
                active
                  ? "bg-(--color-accent)/10 text-(--color-accent)"
                  : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
              ].join(" ")}
              title={p.description ?? p.name}
            >
              <span
                aria-hidden
                className={[
                  "shrink-0 font-mono",
                  active
                    ? "text-(--color-accent)"
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
              <span className="min-w-0 flex-1 truncate lowercase tracking-wide">
                {p.name}
              </span>
              {active ? (
                <span className="shrink-0 text-(--color-accent)/70">●</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
