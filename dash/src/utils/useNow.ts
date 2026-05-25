"use client";

import { useState } from "react";
import useSWR from "swr";

/**
 * Re-renders on a fixed cadence so derived state (offline flag,
 * clock-mode preview, "ago" labels) stays fresh without an external
 * data pull. Use the longest interval that still feels responsive —
 * 1s for the clock simulator, 5s for offline indicators.
 *
 * Backed by SWR with a per-cadence cache key so multiple consumers
 * at the same interval share a single timer + render trigger.
 */
export function useNow(intervalMs: number): number {
  // Lazy initial keeps `Date.now()` out of the render body (it runs
  // once, in the initializer) and seeds SWR's fallback so the first
  // paint has a real timestamp.
  const [initialNow] = useState(() => Date.now());
  const { data } = useSWR(`__now/${intervalMs}`, () => Date.now(), {
    refreshInterval: intervalMs,
    fallbackData: initialNow,
  });
  return data;
}
