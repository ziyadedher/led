"use client";

import { useEffect, useRef } from "react";

import { panels, type PanelMode } from "@/utils/actions";

/**
 * Coalesces rapid `setMode` calls so slider drags don't ship one
 * Supabase write per intermediate value. Auto-flushes on unmount;
 * `flush()` is exposed for commit-style events that shouldn't queue.
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
