"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import { AnimatePresence, motion } from "framer-motion";
import { useContext } from "react";

import { entries } from "@/utils/actions";
import { PanelContext } from "@/app/context";

export function EntriesList() {
  const panelId = useContext(PanelContext);
  const entriesData = entries.get.useSWR(panelId);
  const scrollData = entries.scroll.get.useSWR(panelId);

  if (entriesData.isLoading) {
    return (
      <div className="rounded-2xl border border-dashed border-(--color-border) bg-(--color-surface)/50 p-10 text-center">
        <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-(--color-border-strong) border-t-(--color-accent)" />
        <p className="font-mono text-xs text-(--color-text-dim)">loading…</p>
      </div>
    );
  }

  if (entriesData.error || !entriesData.data) {
    return (
      <div className="rounded-2xl border border-(--color-border) bg-(--color-surface)/50 p-10 text-center">
        <p className="font-mono text-xs text-(--color-danger)">
          couldn&apos;t load entries
        </p>
      </div>
    );
  }

  const items = entriesData.data.entries;

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-(--color-border) bg-(--color-surface)/30 p-10 text-center">
        <p className="font-mono text-xs text-(--color-text-dim)">
          no entries yet
        </p>
        <p className="mt-1 font-mono text-[10px] text-(--color-text-dim)">
          send something above
        </p>
      </div>
    );
  }

  const scroll = scrollData.data?.scroll;

  return (
    <ul className="space-y-2">
      <AnimatePresence initial={false}>
        {items.map((entry, index) => {
          const visible =
            scroll !== undefined && index >= scroll && index < scroll + 7;
          return (
            <motion.li
              key={entry.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
              className={[
                "group flex items-center gap-3 rounded-xl border bg-(--color-surface) px-3 py-2 transition",
                visible
                  ? "border-(--color-accent)/40 shadow-[0_0_0_1px_var(--color-accent)/20]"
                  : "border-(--color-border)",
              ].join(" ")}
            >
              <div className="flex shrink-0 flex-col">
                <button
                  onClick={async () => {
                    if (index === 0) return;
                    await entries.order.patch.call(panelId, entry.order, "Up");
                    const swapped = items
                      .with(index - 1, items[index])
                      .with(index, items[index - 1]);
                    await entriesData.mutate({ entries: swapped });
                  }}
                  disabled={index === 0}
                  className="text-(--color-text-dim) hover:text-(--color-text) disabled:invisible"
                  aria-label="Move up"
                >
                  <ArrowUpIcon className="h-3.5 w-3.5" />
                </button>
                <button
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
                  className="text-(--color-text-dim) hover:text-(--color-text) disabled:invisible"
                  aria-label="Move down"
                >
                  <ArrowDownIcon className="h-3.5 w-3.5" />
                </button>
              </div>

              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {entry.data.text}
              </span>

              {visible ? (
                <span className="shrink-0 rounded-md bg-(--color-accent)/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent)">
                  visible
                </span>
              ) : null}

              <button
                onClick={async () => {
                  await entries.delete.call(panelId, entry.id);
                  await entriesData.mutate({
                    entries: items.filter((e) => e.id !== entry.id),
                  });
                }}
                className="shrink-0 text-(--color-text-dim) opacity-0 transition hover:text-(--color-danger) group-hover:opacity-100"
                aria-label="Delete"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
