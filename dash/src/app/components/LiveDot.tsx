"use client";

/**
 * Pulsing accent dot. Used as a "Realtime is connected" affordance.
 * Decorative — the actual connection state isn't checked because the
 * top-level Realtime subscription is mounted unconditionally on the page;
 * if that's down, the whole page is offline and the dot's status is
 * irrelevant.
 */
export function LiveDot() {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-2 w-2 items-center justify-center"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-(--color-accent) opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-(--color-accent)" />
    </span>
  );
}
