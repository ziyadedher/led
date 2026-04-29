"use client";

import { useEffect, useRef } from "react";

import { panels, type PanelMode } from "@/utils/actions";

/**
 * Debounced wrapper around `panels.setMode.call`. Slider drags fire
 * an onChange per intermediate value — without this, dragging the
 * gif speed slider produced 30+ Supabase writes that each bumped
 * `last_updated`, broadcast back over realtime, and forced the
 * driver's ConfigCache to invalidate (re-parsing 720KB of jsonb on a
 * Pi Zero W per intermediate value).
 *
 * Returns `[push, flush]`. `push(config)` schedules a write; if
 * called again within the debounce window the prior write is
 * cancelled. `flush()` forces any pending write to fire immediately
 * — call it on commit-style events (segmented-control click, file
 * upload, transmit) where queueing isn't appropriate.
 *
 * The hook also auto-flushes on unmount so a half-typed value
 * doesn't get dropped if the user navigates away.
 */
export function useDebouncedSetMode<C>(
  panelId: string,
  mode: PanelMode,
  delayMs = 250,
): [(config: C) => void, () => void] {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<C | null>(null);

  const flush = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending == null) return;
    pendingRef.current = null;
    void panels.setMode.call(
      panelId,
      mode,
      pending as unknown as Record<string, unknown>,
    );
  };

  const push = (config: C) => {
    pendingRef.current = config;
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, delayMs);
  };

  // Auto-flush on unmount.
  useEffect(() => {
    return () => {
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [push, flush];
}
