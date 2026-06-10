"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

const subscribe = (onChange: () => void) => {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
};

/**
 * True when the user asked for reduced motion. globals.css already
 * neutralizes the CSS animations; this is for the JS-driven motion the
 * stylesheet can't reach — the WASM simulator's rAF loop and the Life
 * lattice ticker, which are exactly the kind of sustained full-panel
 * movement the preference exists for.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // SSR: assume no preference; the client snapshot corrects on mount.
    () => false,
  );
}
