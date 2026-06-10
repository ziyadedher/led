"use client";

import { FOCUS_RING } from "./ui";

/** Shared cell surface. Each plate cell paints its own background so
 * the container's `gap-px` over a border-colored backdrop renders
 * hairline dividers on BOTH axes when the plate wraps — per-cell side
 * borders left wrapped rows borderless and doubled the container
 * edge. (Same scheme ModeSwitcher uses for its tile grid.) */
const CELL_BG = "bg-gradient-to-b from-(--color-surface-2) to-(--color-surface)";

/**
 * Section header plate — the "instrument label" bar that titles the
 * simulator and queue sections. Left tag cell (`:: title / subtitle`),
 * flex spacer, then right-side cells/buttons passed as children.
 * Wraps cleanly: on narrow viewports trailing cells fall to a second
 * hairline-divided row instead of overflowing.
 */
export function SectionPlate({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  /** Right-side cells — compose from PlateCell / PlateButton. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        "flex flex-wrap gap-px border border-(--color-border) bg-(--color-border)",
        className ?? "",
      ].join(" ")}
    >
      <div
        className={`flex min-w-0 items-center gap-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.3em] ${CELL_BG}`}
      >
        <span className="text-(--color-accent)">::</span>
        <span className="text-(--color-text)">{title}</span>
        {subtitle ? (
          <>
            <span className="text-(--color-text-faint)">/</span>
            <span className="min-w-0 truncate text-(--color-text-muted)">
              {subtitle}
            </span>
          </>
        ) : null}
      </div>

      <span aria-hidden className={`min-w-2 flex-1 ${CELL_BG}`} />

      {children}
    </div>
  );
}

/** Passive cell on the right side of a SectionPlate. */
export function PlateCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        "flex items-center gap-2 px-3 py-1.5",
        "font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint)",
        CELL_BG,
        className ?? "",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * Interactive transport chip in a SectionPlate (pause/live, off/on).
 * Tone classes come from the caller; the base chrome and focus ring
 * stay canonical here.
 */
export function PlateButton({
  onClick,
  ariaLabel,
  title,
  tone,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  /** Text/hover tone classes, e.g. "text-(--color-phosphor) hover:bg-…". */
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className={[
        "flex items-center gap-2 px-3 py-1.5",
        "text-[10px] uppercase tracking-[0.3em] transition-colors active:brightness-90",
        // Solid color (not the gradient): hover tones swap
        // background-color, which a background-image gradient would
        // paint straight over.
        "bg-(--color-surface-2)",
        FOCUS_RING,
        "focus-visible:ring-inset",
        tone,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
