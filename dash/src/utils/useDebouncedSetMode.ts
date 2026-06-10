"use client";

import { useEffect, useRef } from "react";

import { panels, type PanelMode } from "@/utils/actions";

export type DebouncedConfigWriter<C> = {
  /** Stage a config and (re)arm the debounce timer. */
  push: (config: C) => void;
  /** Persist any staged config immediately. */
  flush: () => void;
  /** Drop any staged config without writing it. */
  cancel: () => void;
  /**
   * Resolves once the most recently fired write settles. Await this
   * before issuing a competing write (e.g. a file upload's setMode)
   * so a debounced write that already left can't land after it and
   * clobber the newer payload.
   */
  settle: () => Promise<void>;
};

/**
 * Coalesces rapid config edits so slider drags don't ship one
 * Supabase write per intermediate value. Auto-flushes on unmount.
 *
 * Writes go through `panels.setModeConfig`, which updates ONLY
 * mode_config and is server-side guarded on the panel still being in
 * `mode` — so a flush that fires after the user switched modes (timer
 * or unmount; the composer unmounts precisely BECAUSE the mode
 * changed) is a harmless zero-row no-op instead of flipping the panel
 * back to the old mode.
 */
export function useDebouncedSetMode<C>(
  panelId: string,
  mode: PanelMode,
  delayMs = 250,
): DebouncedConfigWriter<C> {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The pending config carries the panel/mode it was edited against,
  // captured at push() time (an event handler, so reading the current
  // values is fine). flush() then writes to THAT target — switching
  // panels mid-debounce (or before the unmount flush) can't misdirect
  // a queued write to the wrong panel.
  const pendingRef = useRef<{
    config: C;
    panelId: string;
    mode: PanelMode;
  } | null>(null);
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());

  const cancel = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
  };

  const flush = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending == null) return;
    pendingRef.current = null;
    // Chain on the previous write rather than replacing it: writes
    // land at the DB in issue order (no old-payload-lands-last race),
    // and settle() — which returns this ref — genuinely waits for
    // every outstanding write, not just the newest one.
    inFlightRef.current = inFlightRef.current
      .then(() =>
        panels.setModeConfig.call(
          pending.panelId,
          pending.mode,
          pending.config as unknown as Record<string, unknown>,
        ),
      )
      .catch((err) => {
        // The local draft keeps the user's edit; surface the divergence
        // for diagnostics rather than failing silently forever.
        console.error("debounced mode_config write failed", err);
      });
  };

  const push = (config: C) => {
    pendingRef.current = { config, panelId, mode };
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, delayMs);
  };

  const settle = () => {
    flush();
    return inFlightRef.current;
  };

  // Auto-flush on unmount. flush() reads the captured target from the
  // pending ref, so the empty dep list is correct — no stale closure.
  useEffect(() => {
    return () => {
      flush();
    };
  }, []);

  return { push, flush, cancel, settle };
}
