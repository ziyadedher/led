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

/**
 * Compact "5s ago" / "2m ago" / "3h ago" / "4d ago" formatter, used
 * in tooltips that surface a panel's last heartbeat. Returns
 * "never" when last_seen is missing/unparseable.
 */
export function relativeTime(
  iso: string | null | undefined,
  now: number,
): string {
  if (!iso) return "never";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "never";
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
