"use client";

import { useState } from "react";

/**
 * Local-state mirror of an upstream prop. Returns `[value, setValue]`
 * just like `useState`, but resets `value` whenever `key` changes —
 * letting composers carry editable copies of a config object without
 * snapping the form mid-edit on every unrelated SWR refresh.
 *
 * The state-during-render reset is the React 19 idiom for this — it
 * deduplicates and skips the extra paint, no `useEffect` needed.
 */
export function useSyncedFromProp<T>(key: string, initial: T): [T, (next: T) => void] {
  const [snapshotKey, setSnapshotKey] = useState(key);
  const [value, setValue] = useState<T>(initial);
  if (snapshotKey !== key) {
    setSnapshotKey(key);
    setValue(initial);
  }
  return [value, setValue];
}
