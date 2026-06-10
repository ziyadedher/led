import type { PanelMode } from "@/utils/actions";

/**
 * Session-scoped cache of the last mode_config we KNOW for each
 * `panelId:mode`. The DB stores a single mode_config column shared
 * across modes, so switching modes overwrites the outgoing editor's
 * work — this cache is what lets ModeSwitcher restore it on the way
 * back.
 *
 * Two writers keep it fresh:
 *  - write-through from actions.ts (setMode / setModeConfig), so the
 *    cache always holds the last value actually written — the SWR
 *    snapshot lags by debounce + write RTT + realtime-echo RTT, and
 *    restoring from it silently reverted recent edits;
 *  - ModeSwitcher's snapshot of the server row on switch.
 * Entries carry a timestamp and the newer value wins, so a fresh
 * local write beats the lagging SWR snapshot while an external
 * writer's newer row beats a stale session entry.
 */
type Entry = { config: Record<string, unknown>; at: number };

const cache = new Map<string, Entry>();

const key = (panelId: string, mode: PanelMode) => `${panelId}:${mode}`;

/**
 * `at` is the wall-clock time the config is known-true for (write
 * time, or the row's last_updated for server snapshots). It lets
 * ModeSwitcher prefer a NEWER server row over a stale session entry —
 * without it, an external writer's config (MCP paint, a second tab)
 * would be silently overwritten on the next mode round-trip.
 */
export function rememberModeConfig(
  panelId: string,
  mode: PanelMode,
  config: Record<string, unknown>,
  at: number = Date.now(),
): void {
  if (Object.keys(config).length === 0) return;
  const existing = cache.get(key(panelId, mode));
  if (existing && existing.at > at) return;
  cache.set(key(panelId, mode), { config, at });
}

export function recallModeConfig(
  panelId: string,
  mode: PanelMode,
): Record<string, unknown> | undefined {
  return cache.get(key(panelId, mode))?.config;
}
