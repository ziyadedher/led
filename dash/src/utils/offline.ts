/**
 * Panel-liveness derivation. The driver writes panels.last_seen on
 * every 30s heartbeat; if a panel hasn't checked in for ≥3× that
 * (90s) we flag it offline.
 *
 * Threshold sized to absorb one missed heartbeat (network blip,
 * brief service restart) without flapping; bigger and stale panels
 * linger green, smaller and a single packet loss kicks the badge.
 */

export const OFFLINE_THRESHOLD_MS = 90_000;

export function isOffline(
  lastSeen: string | null | undefined,
  now: number,
): boolean {
  if (!lastSeen) return true;
  const ts = Date.parse(lastSeen);
  if (Number.isNaN(ts)) return true;
  return now - ts > OFFLINE_THRESHOLD_MS;
}
