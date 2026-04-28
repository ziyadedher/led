"use client";

import { Bars3Icon, TrashIcon } from "@heroicons/react/16/solid";
import { AnimatePresence, motion, Reorder } from "framer-motion";
import { useContext, useState } from "react";

import { PanelContext } from "@/app/context";
import { entries, type TextEntryItem } from "@/utils/actions";

const VISIBLE_SLOTS = 7;

export function EntriesList() {
  const panelId = useContext(PanelContext);
  const entriesData = entries.get.useSWR(panelId);
  const scrollData = entries.scroll.get.useSWR(panelId);

  // While a drag/reorder/delete is in flight we render the optimistic
  // list; once the round-trip completes we drop back to server-driven
  // by setting it null. Avoids the setState-in-effect anti-pattern.
  const [optimistic, setOptimistic] = useState<TextEntryItem[] | null>(null);
  const items = optimistic ?? entriesData.data?.entries ?? [];

  if (entriesData.isLoading) {
    return <Empty muted>loading messages ···</Empty>;
  }
  if (entriesData.error || !entriesData.data) {
    return (
      <div className="border border-(--color-danger)/40 bg-(--color-danger)/5 px-4 py-8 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-danger)">
          err: read failed
        </p>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <Empty>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          nothing on the wall
        </p>
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-(--color-text-faint)">
          transmit a payload to begin
        </p>
      </Empty>
    );
  }

  const scroll = scrollData.data?.scroll ?? 0;
  const visibleCount = Math.min(VISIBLE_SLOTS, items.length - scroll);

  const handleReorder = async (next: TextEntryItem[]) => {
    setOptimistic(next);
    try {
      await entries.reorder.call(
        panelId,
        next.map((e) => e.id),
      );
      await entriesData.mutate({ entries: next });
    } finally {
      setOptimistic(null);
    }
  };

  const handleDelete = async (id: string) => {
    const next = items.filter((e) => e.id !== id);
    setOptimistic(next);
    try {
      await entries.delete.call(panelId, id);
      await entriesData.mutate({ entries: next });
    } finally {
      setOptimistic(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.25em] tabular-nums text-(--color-text-faint)">
        <span className="flex items-baseline gap-2">
          <span>loaded</span>
          <span
            className="text-(--color-text)"
            style={{ fontFamily: "var(--font-pixel)", fontSize: 13 }}
          >
            {String(items.length).padStart(2, "0")}
          </span>
          <span>·</span>
          <span>on-air</span>
          <span
            className="text-(--color-phosphor)"
            style={{ fontFamily: "var(--font-pixel)", fontSize: 13 }}
          >
            {String(visibleCount).padStart(2, "0")}
          </span>
        </span>
      </div>
      <Reorder.Group
        axis="y"
        values={items}
        onReorder={handleReorder}
        className="bezel-recessed flex flex-col gap-px border border-(--color-border) bg-(--color-surface)/40"
      >
        <AnimatePresence initial={false}>
          {items.map((entry, index) => {
            const visible = index >= scroll && index < scroll + VISIBLE_SLOTS;
            return (
              <Reorder.Item
                key={entry.id}
                value={entry}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                whileDrag={{
                  scale: 1.01,
                  boxShadow:
                    "0 4px 16px rgba(0,0,0,0.6), 0 0 0 1px var(--color-accent)",
                  zIndex: 10,
                }}
                className={[
                  "group relative flex cursor-grab select-none items-center gap-3 border-l-2 px-3 py-2 transition-colors active:cursor-grabbing",
                  visible
                    ? "border-(--color-phosphor) bg-(--color-phosphor)/5"
                    : "border-transparent bg-transparent",
                ].join(" ")}
              >
                <Bars3Icon
                  aria-hidden
                  className={[
                    "h-3 w-3 shrink-0",
                    visible
                      ? "text-(--color-phosphor)/70"
                      : "text-(--color-text-faint)",
                  ].join(" ")}
                />

                <span
                  aria-hidden
                  className={[
                    "shrink-0 tabular-nums",
                    visible
                      ? "text-(--color-phosphor)"
                      : "text-(--color-text-faint)",
                  ].join(" ")}
                  style={{
                    fontFamily: "var(--font-pixel)",
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>

                <span
                  className={[
                    "min-w-0 flex-1 truncate font-mono text-sm",
                    visible
                      ? "text-(--color-text)"
                      : "text-(--color-text-muted)",
                  ].join(" ")}
                >
                  {entry.data.text}
                </span>

                {visible ? (
                  <span
                    aria-hidden
                    className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-(--color-phosphor)"
                  >
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-(--color-phosphor)" />
                    on-air
                  </span>
                ) : (
                  <span
                    aria-hidden
                    className="shrink-0 font-mono text-[9px] uppercase tracking-[0.25em] text-(--color-text-faint)"
                  >
                    queued
                  </span>
                )}

                <motion.button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => handleDelete(entry.id)}
                  // Touch devices don't fire :hover, so the
                  // group-hover gate would render the button
                  // unreachable; show it always there.
                  className="shrink-0 cursor-pointer p-1 text-(--color-text-faint) transition-colors hover:text-(--color-danger) sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                  aria-label="Delete"
                >
                  <TrashIcon className="h-3 w-3" />
                </motion.button>
              </Reorder.Item>
            );
          })}
        </AnimatePresence>
      </Reorder.Group>
    </div>
  );
}

function Empty({
  muted,
  children,
}: {
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "flex flex-col items-center gap-2 border border-dashed border-(--color-border) px-4 py-10 text-center",
        muted ? "bg-(--color-surface)/30" : "bg-(--color-surface)/40",
      ].join(" ")}
    >
      {typeof children === "string" ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          {children}
        </p>
      ) : (
        children
      )}
    </div>
  );
}
