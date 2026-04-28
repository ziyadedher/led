"use client";

import { useEffect, useState } from "react";

/**
 * Re-renders on a fixed cadence so derived state (offline flag,
 * clock-mode preview, "ago" labels) stays fresh without an external
 * data pull. Use the longest interval that still feels responsive
 * for what you're computing — 1s for the clock simulator, 5s for
 * offline indicators.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
