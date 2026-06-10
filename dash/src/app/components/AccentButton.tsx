"use client";

import { FOCUS_RING, PixelValue } from "./ui";

/**
 * Primary accent CTA — glyph plate on the left, tracked label, an
 * optional right-aligned hint (text or kbd chip), and the tape-head
 * sweep on hover. Shared by the composer's transmit button and the
 * error boundary's retry.
 */
export function AccentButton({
  glyph,
  label,
  hint,
  kbd,
  type = "button",
  disabled = false,
  onClick,
}: {
  /** Pixel-font glyph shown in the bordered plate (e.g. "▲", "↻"). */
  glyph: string;
  label: string;
  /** Right-aligned faint hint text. */
  hint?: string;
  /** Right-aligned keybind chip (overrides `hint`'s styling slot). */
  kbd?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={[
        "group relative flex w-full items-center justify-between overflow-hidden",
        "border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-3 text-(--color-accent)",
        "transition hover:bg-(--color-accent)/20 hover:shadow-[0_0_24px_-8px_var(--color-accent-fade)]",
        "disabled:cursor-not-allowed disabled:border-(--color-border) disabled:bg-transparent disabled:text-(--color-text-faint) disabled:hover:shadow-none",
        FOCUS_RING,
      ].join(" ")}
    >
      <span className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center border border-(--color-accent)/40 group-disabled:border-(--color-border)"
        >
          <PixelValue size="lg">{glyph}</PixelValue>
        </span>
        <span className="font-mono text-xs uppercase tracking-[0.4em]">
          {label}
        </span>
      </span>

      {kbd ? (
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] opacity-70">
          <kbd className="border border-(--color-accent)/30 bg-(--color-bg)/50 px-1.5 py-0.5 group-disabled:border-(--color-border)">
            {kbd}
          </kbd>
        </span>
      ) : hint ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] opacity-70">
          {hint}
        </span>
      ) : null}

      {/* Sweep highlight on hover — like a tape head passing over */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/15 to-transparent transition-all duration-700 group-hover:left-full group-disabled:hidden"
      />
    </button>
  );
}
