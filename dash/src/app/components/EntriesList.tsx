"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import { AnimatePresence, motion } from "framer-motion";
import { useContext } from "react";

import { PanelContext } from "@/app/context";
import { entries } from "@/utils/actions";

const VISIBLE_SLOTS = 7;

export function EntriesList() {
  const panelId = useContext(PanelContext);
  const entriesData = entries.get.useSWR(panelId);
  const scrollData = entries.scroll.get.useSWR(panelId);

  if (entriesData.isLoading) {
    return (
      <div className="border border-dashed border-(--color-border) bg-(--color-surface)/50 px-4 py-8 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          loading queue ···
        </p>
      </div>
    );
  }

  if (entriesData.error || !entriesData.data) {
    return (
      <div className="border border-(--color-danger)/40 bg-(--color-danger)/5 px-4 py-8 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-danger)">
          err: queue read failed
        </p>
      </div>
    );
  }

  const items = entriesData.data.entries;

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 border border-dashed border-(--color-border) bg-(--color-surface)/30 px-4 py-10 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          queue empty
        </p>
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-(--color-text-faint)">
          transmit a payload to begin
        </p>
      </div>
    );
  }

  const scroll = scrollData.data?.scroll ?? 0;
  const visibleCount = Math.min(VISIBLE_SLOTS, items.length - scroll);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint) tabular-nums">
        <span>
          {String(items.length).padStart(2, "0")} loaded ·{" "}
          {String(visibleCount).padStart(2, "0")} on-air
        </span>
        <span>
          slot {String(scroll + 1).padStart(2, "0")}–
          {String(scroll + visibleCount).padStart(2, "0")}
        </span>
      </div>
      <ul className="flex flex-col gap-px border border-(--color-border) bg-(--color-surface)/40">
        <AnimatePresence initial={false}>
          {items.map((entry, index) => {
            const visible = index >= scroll && index < scroll + VISIBLE_SLOTS;
            return (
              <motion.li
                key={entry.id}
                layout
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 4 }}
                transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                className={[
                  "group flex items-center gap-3 px-3 py-2 transition-colors",
                  visible
                    ? "bg-(--color-accent)/5"
                    : "bg-transparent",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "shrink-0 font-mono text-[10px] tabular-nums",
                    visible
                      ? "text-(--color-accent)"
                      : "text-(--color-text-faint)",
                  ].join(" ")}
                >
                  [{String(index + 1).padStart(2, "0")}]
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

                <span
                  aria-hidden
                  className={[
                    "shrink-0 font-mono text-[9px] uppercase tracking-[0.25em] tabular-nums",
                    visible
                      ? "text-(--color-phosphor)"
                      : "text-(--color-text-faint)",
                  ].join(" ")}
                >
                  {visible ? "on-air" : "queued"}
                </span>

                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={async () => {
                      if (index === 0) return;
                      await entries.order.patch.call(
                        panelId,
                        entry.order,
                        "Up",
                      );
                      const swapped = items
                        .with(index - 1, items[index])
                        .with(index, items[index - 1]);
                      await entriesData.mutate({ entries: swapped });
                    }}
                    disabled={index === 0}
                    className="p-1 text-(--color-text-faint) hover:text-(--color-text) disabled:invisible"
                    aria-label="Move up"
                  >
                    <ArrowUpIcon className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (index === items.length - 1) return;
                      await entries.order.patch.call(
                        panelId,
                        entry.order,
                        "Down",
                      );
                      const swapped = items
                        .with(index, items[index + 1])
                        .with(index + 1, items[index]);
                      await entriesData.mutate({ entries: swapped });
                    }}
                    disabled={index === items.length - 1}
                    className="p-1 text-(--color-text-faint) hover:text-(--color-text) disabled:invisible"
                    aria-label="Move down"
                  >
                    <ArrowDownIcon className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await entries.delete.call(panelId, entry.id);
                      await entriesData.mutate({
                        entries: items.filter((e) => e.id !== entry.id),
                      });
                    }}
                    className="p-1 text-(--color-text-faint) transition-colors hover:text-(--color-danger)"
                    aria-label="Delete"
                  >
                    <TrashIcon className="h-3 w-3" />
                  </button>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
