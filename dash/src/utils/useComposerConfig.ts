"use client";

import { useDebouncedSetMode } from "@/utils/useDebouncedSetMode";
import { useSyncedFromProp } from "@/utils/useSyncedFromProp";
import type { PanelMode } from "@/utils/actions";

/**
 * One hook for every mode editor: holds an editable local mirror of
 * the panel's persisted `mode_config` and debounce-writes changes
 * back to Supabase.
 *
 * The local mirror resets only when the *target* changes
 * (`panelId:mode`) — NOT when the config value changes. Keying on the
 * value (e.g. `JSON.stringify(config)`) was the old footgun: a server
 * echo of the user's own edit produced a new key and snapped the form
 * back mid-drag. Keying on identity means a realtime refresh of the
 * same panel/mode leaves the in-progress edit alone.
 *
 * Returns `[draft, update, flush]`:
 *  - `draft`   — current editable config
 *  - `update`  — set the draft AND queue a debounced persist
 *  - `flush`   — persist immediately (for commit-style events / blur)
 */
export function useComposerConfig<C>(
  panelId: string,
  mode: PanelMode,
  initial: C,
  delayMs = 250,
): [C, (next: C) => void, () => void] {
  const [draft, setDraft] = useSyncedFromProp<C>(`${panelId}:${mode}`, initial);
  const [push, flush] = useDebouncedSetMode<C>(panelId, mode, delayMs);

  const update = (next: C) => {
    setDraft(next);
    push(next);
  };

  return [draft, update, flush];
}
