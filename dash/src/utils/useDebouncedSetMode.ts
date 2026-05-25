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
  // The pending config carries the panel/mode it was edited against,
  // captured at push() time (an event handler, so reading the current
  // values is fine). flush() then writes to THAT target — switching
  // panels mid-debounce (or before the unmount flush) can't misdirect
  // a queued write to the wrong panel, the old first-render-capture bug.
  const pendingRef = useRef<{
    config: C;
    panelId: string;
    mode: PanelMode;
  } | null>(null);

  const flush = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending == null) return;
    pendingRef.current = null;
    void panels.setMode.call(
      pending.panelId,
      pending.mode,
      pending.config as unknown as Record<string, unknown>,
    );
  };

  const push = (config: C) => {
    pendingRef.current = { config, panelId, mode };
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, delayMs);
  };

  // Auto-flush on unmount. flush() reads the captured target from the
  // pending ref, so the empty dep list is correct — no stale closure.
  useEffect(() => {
    return () => {
      flush();
    };
  }, []);

  return [push, flush];
}
