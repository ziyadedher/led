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

  if (error) {
    return (
      <div className="font-mono text-xs text-[--color-danger]">
        couldn&apos;t load panels
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="font-mono text-xs text-[--color-text-dim]">
        no panels yet
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label="Panel"
      className="flex snap-x snap-mandatory items-center gap-1 overflow-x-auto rounded-full border border-[--color-border] bg-[--color-surface] p-1"
    >
      {list.map((p) => {
        const active = p.id === panelId;
        return (
          <button
            key={p.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(p.id)}
            className={[
              "snap-start whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition",
              active
                ? "bg-[--color-accent] text-black shadow-[--shadow-glow]"
                : "text-[--color-text-muted] hover:bg-[--color-surface-2] hover:text-[--color-text]",
            ].join(" ")}
            title={p.description ?? p.name}
          >
            {p.name}
          </button>
        );
      })}
    </div>
  );
}
