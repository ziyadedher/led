"use client";

import {
  Bars3Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import {
  AnimatePresence,
  Reorder,
  useDragControls,
} from "framer-motion";
import { useContext, useEffect, useRef, useState } from "react";

import { PanelContext } from "@/app/context";
import {
  Alert,
  EmptyState,
  FOCUS_RING,
  Lamp,
  PixelValue,
} from "@/app/components/ui";
import { entries, type TextEntryItem } from "@/utils/actions";
import { pad } from "@/utils/format";

const VISIBLE_SLOTS = 7;

// How long an armed delete confirm stays live before disarming itself.
// Long enough to read and reach the button, short enough that a
// forgotten confirm isn't a landmine for the next tap.
const CONFIRM_DISARM_MS = 4000;

export function EntriesList() {
  const panelId = useContext(PanelContext);
  const entriesData = entries.get.useSWR(panelId);
  const scrollData = entries.scroll.get.useSWR(panelId);

  // Local order is held ONLY while a drag is in progress (framer-motion
  // needs a stable `values` array to animate against mid-drag). On drag
  // end we commit once; otherwise we render straight from the SWR cache,
  // whose optimistic update is owned by actions.ts.
  const [dragOrder, setDragOrder] = useState<TextEntryItem[] | null>(null);
  // Inline error surfaced when a reorder/delete round-trip fails. The
  // optimistic cache rolls back in actions.ts; this tells the user why
  // the list snapped back.
  const [actionError, setActionError] = useState<string | null>(null);
  // Row pending delete confirmation — a first click arms it, a second
  // (or the explicit confirm button) commits. Guards against fat-finger
  // deletes from the tiny per-row control.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // An armed confirm must not survive a panel switch — the next panel's
  // queue would render with a live "delete" button on whatever row
  // happens to share the id-less slot. Render-time adjust, matching the
  // `effectsPanelId` idiom in page.tsx.
  const [confirmPanelId, setConfirmPanelId] = useState(panelId);
  if (confirmPanelId !== panelId) {
    setConfirmPanelId(panelId);
    setConfirmingId(null);
  }

  // Auto-disarm a confirm the user walked away from.
  useEffect(() => {
    if (confirmingId === null) return;
    const timer = setTimeout(() => setConfirmingId(null), CONFIRM_DISARM_MS);
    return () => clearTimeout(timer);
  }, [confirmingId]);

  const serverItems = entriesData.data?.entries ?? [];
  const items = dragOrder ?? serverItems;

  if (entriesData.isLoading) {
    return <EmptyState variant="block" title="loading messages ···" />;
  }
  if (entriesData.error || !entriesData.data) {
    return <Alert center>err: read failed</Alert>;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="nothing on the wall"
        detail="transmit a payload to begin"
      />
    );
  }

  const scroll = scrollData.data?.scroll ?? 0;
  const visibleCount = Math.min(VISIBLE_SLOTS, items.length - scroll);

  // During a drag framer-motion fires onReorder on every intermediate
  // position. We only stash the new order locally here — committing on
  // each move spammed N parallel UPDATEs per pixel of travel.
  const handleReorder = (next: TextEntryItem[]) => {
    setDragOrder(next);
  };

  // Commit the final order exactly once when the drag settles. Compare
  // against the server order so a click (no actual move) is a no-op.
  const handleReorderCommit = async () => {
    const next = dragOrder;
    if (!next) return;
    const serverIds = serverItems.map((e) => e.id).join(",");
    const nextIds = next.map((e) => e.id);
    if (nextIds.join(",") === serverIds) {
      setDragOrder(null);
      return;
    }
    setActionError(null);
    try {
      await entries.reorder.call(panelId, nextIds);
    } catch {
      // actions.ts already rolled back the optimistic cache; tell the
      // user why the list jumped back.
      setActionError("reorder failed · order restored");
    } finally {
      // Drop back to the (now-authoritative or rolled-back) SWR cache.
      setDragOrder(null);
    }
  };

  // Keyboard/tap alternative to drag — order decides what's on-air, so
  // it can't be drag-only. Swap against the SERVER order, not the
  // rendered one, so a stale mid-drag snapshot can't be committed.
  const handleMove = async (entry: TextEntryItem, direction: -1 | 1) => {
    const ids = serverItems.map((e) => e.id);
    const from = ids.indexOf(entry.id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setActionError(null);
    try {
      await entries.reorder.call(panelId, ids);
    } catch {
      setActionError("reorder failed · order restored");
    }
  };

  const handleDelete = async (entry: TextEntryItem) => {
    setConfirmingId(null);
    setActionError(null);
    try {
      await entries.delete.call(panelId, entry.id);
    } catch {
      setActionError(`delete failed · "${entry.data.text}" restored`);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.25em] tabular-nums text-(--color-text-faint)">
        <span className="flex items-baseline gap-2">
          <span>loaded</span>
          <PixelValue size="sm" className="text-(--color-text)">
            {pad(items.length)}
          </PixelValue>
          <span>·</span>
          <span>on-air</span>
          <PixelValue size="sm" className="text-(--color-phosphor)">
            {pad(visibleCount)}
          </PixelValue>
          {/* Seven-slot VU bargraph mirroring the on-air window; the
              text counts carry the info for screen readers. Bottom
              edges sit on the counts baseline (a textless flex item's
              baseline is its bottom margin edge). */}
          <span aria-hidden className="flex gap-px">
            {Array.from({ length: VISIBLE_SLOTS }, (_, slot) => (
              <span
                key={slot}
                className={[
                  "h-2 w-1",
                  slot < visibleCount ? "bg-(--color-phosphor)" : "bg-white/5",
                ].join(" ")}
                style={
                  slot < visibleCount
                    ? { boxShadow: "0 0 4px var(--color-phosphor)" }
                    : undefined
                }
              />
            ))}
            {items.length > VISIBLE_SLOTS ? (
              // Overflow cell: messages queued beyond the on-air window.
              <span className="h-2 w-1 animate-pulse bg-(--color-amber)" />
            ) : null}
          </span>
        </span>
      </div>

      {actionError ? <Alert>{actionError}</Alert> : null}

      <Reorder.Group
        axis="y"
        values={items}
        onReorder={handleReorder}
        className="bezel-recessed flex flex-col gap-px border border-(--color-border) bg-(--color-surface)/40"
      >
        <AnimatePresence initial={false}>
          {items.map((entry, index) => (
            <Row
              key={entry.id}
              entry={entry}
              index={index}
              total={items.length}
              visible={index >= scroll && index < scroll + VISIBLE_SLOTS}
              confirming={confirmingId === entry.id}
              onArm={() => {
                setActionError(null);
                setConfirmingId(entry.id);
              }}
              onCancel={() => setConfirmingId(null)}
              onDelete={() => void handleDelete(entry)}
              onMove={(direction) => void handleMove(entry, direction)}
              onDragCommit={() => void handleReorderCommit()}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </div>
  );
}

// Per-row subcomponent so each row owns its useDragControls instance.
function Row({
  entry,
  index,
  total,
  visible,
  confirming,
  onArm,
  onCancel,
  onDelete,
  onMove,
  onDragCommit,
}: {
  entry: TextEntryItem;
  index: number;
  total: number;
  visible: boolean;
  confirming: boolean;
  onArm: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onDragCommit: () => void;
}) {
  // Drag starts ONLY from the handle button (dragListener={false}).
  // With the whole row draggable, a touch swipe over the queue
  // reordered instead of scrolling the page.
  const controls = useDragControls();
  const text = entry.data.text;

  // When the armed confirm disarms (cancel / Escape / auto-timeout),
  // the focused confirm button unmounts and keyboard focus falls to
  // <body> — restore it to the trash button so the user keeps their
  // place in the queue. Gated on focus actually being orphaned, so a
  // 4s auto-disarm can't yank focus from wherever the user went next.
  const trashRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (
      wasConfirming.current &&
      !confirming &&
      document.activeElement === document.body
    ) {
      trashRef.current?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirming]);
  // Shared visibility gate for the per-row controls: always reachable
  // on touch (no :hover there), revealed on hover/focus on sm+.
  const revealOnHover =
    "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100";

  return (
    <Reorder.Item
      value={entry}
      dragListener={false}
      dragControls={controls}
      // Commit the final order once the drag settles, not on every
      // intermediate onReorder move.
      onDragEnd={onDragCommit}
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
        "group relative flex select-none items-center gap-2 border-l-2 px-3 py-2 transition-colors",
        visible
          ? "border-(--color-phosphor) bg-(--color-phosphor)/5"
          : "border-transparent bg-transparent",
      ].join(" ")}
    >
      <button
        type="button"
        // touch-none so the browser doesn't claim the gesture for
        // scrolling once a drag starts from the handle.
        onPointerDown={(e) => controls.start(e)}
        className={[
          "flex min-h-8 min-w-8 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing",
          visible ? "text-(--color-phosphor)/70" : "text-(--color-text-faint)",
          FOCUS_RING,
        ].join(" ")}
        aria-label={`Drag to reorder "${text}"`}
      >
        <Bars3Icon aria-hidden className="h-3 w-3" />
      </button>

      {/* Decorative slot number — position is already conveyed by list
          order and the move-button labels. */}
      <span aria-hidden className="shrink-0">
        <PixelValue
          size="sm"
          className={
            visible ? "text-(--color-phosphor)" : "text-(--color-text-faint)"
          }
        >
          {pad(index + 1)}
        </PixelValue>
      </span>

      <span
        className={[
          "min-w-0 flex-1 truncate font-mono text-sm",
          visible ? "text-(--color-text)" : "text-(--color-text-muted)",
        ].join(" ")}
      >
        {text}
      </span>

      {visible ? (
        // The chip text stays in the a11y tree — on-air vs queued is the
        // one piece of state that matters here. Only the lamp is
        // decorative (Lamp is aria-hidden internally).
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-(--color-phosphor)">
          <Lamp tone="phosphor" pulse />
          on-air
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.25em] text-(--color-text-faint)">
          queued
        </span>
      )}

      <span className={`flex shrink-0 items-center ${revealOnHover}`}>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className={`flex min-h-8 min-w-8 cursor-pointer items-center justify-center text-(--color-text-faint) transition-colors hover:text-(--color-text) disabled:cursor-default disabled:text-(--color-text-faint)/30 ${FOCUS_RING}`}
          aria-label={`Move "${text}" up to position ${index}`}
        >
          <ChevronUpIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          className={`flex min-h-8 min-w-8 cursor-pointer items-center justify-center text-(--color-text-faint) transition-colors hover:text-(--color-text) disabled:cursor-default disabled:text-(--color-text-faint)/30 ${FOCUS_RING}`}
          aria-label={`Move "${text}" down to position ${index + 2}`}
        >
          <ChevronDownIcon className="h-4 w-4" />
        </button>
      </span>

      {confirming ? (
        // Two-step confirm: avoids an irreversible delete from a single
        // mis-tap on the small per-row control. Escape backs out.
        <span
          className="flex shrink-0 items-center gap-1"
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
        >
          <button
            type="button"
            // Pull focus so the keyboard flow is arm → Enter/Escape.
            autoFocus
            onClick={onDelete}
            className={`flex min-h-8 cursor-pointer items-center border border-(--color-danger)/50 bg-(--color-danger)/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-danger) transition-colors hover:bg-(--color-danger)/20 ${FOCUS_RING}`}
            aria-label={`Confirm delete message "${text}"`}
          >
            delete
          </button>
          <button
            type="button"
            onClick={onCancel}
            className={`flex min-h-8 cursor-pointer items-center px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-text-faint) transition-colors hover:text-(--color-text) ${FOCUS_RING}`}
            aria-label="Cancel delete"
          >
            cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          ref={trashRef}
          onClick={onArm}
          // Touch devices don't fire :hover, so the group-hover gate
          // would render the button unreachable; show it always there.
          // 32px min hit target for touch (the icon stays small).
          className={`flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center text-(--color-text-faint) transition-colors hover:text-(--color-danger) ${revealOnHover} ${FOCUS_RING}`}
          aria-label={`Delete message "${text}"`}
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}
    </Reorder.Item>
  );
}
