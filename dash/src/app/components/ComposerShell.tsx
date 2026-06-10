"use client";

/**
 * Visual chrome for every per-mode composer: corner-bracketed
 * frame + heading bar with a `:: title` left tag and a tiny
 * uppercase status string on the right. The body slot gets the
 * canonical `space-y-5 px-4 py-4` padding by default; composers
 * that own their padding (e.g. an overlay that must cover the
 * full body) opt out with `padded={false}`.
 */
export function ComposerShell({
  title,
  status,
  ariaLabel,
  padded = true,
  children,
}: {
  /** Shown after `::` on the left side of the heading. */
  title: string;
  /** Right-aligned dim status text. */
  status?: string;
  ariaLabel?: string;
  /** Set false when the body needs to manage its own padding. */
  padded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className="relative border border-(--color-border) bg-(--color-surface)/70 backdrop-blur-sm"
      aria-label={ariaLabel ?? title}
    >
      <CornerBracket pos="tl" />
      <CornerBracket pos="tr" />
      <CornerBracket pos="bl" />
      <CornerBracket pos="br" />

      <header className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-2)/40 px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          :: {title}
        </span>
        {/* role=status so async transitions (transmitting → ready)
         * are announced; the changes are otherwise visual-only. */}
        {status ? (
          <span
            role="status"
            className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)"
          >
            {status}
          </span>
        ) : null}
      </header>

      {padded ? <div className="space-y-5 px-4 py-4">{children}</div> : children}
    </section>
  );
}

/**
 * L-shaped bracket at one corner of a parent. Two sizes: `sm` sits
 * flush against an inner border (composer-style chrome), `lg` floats
 * outside the parent for a more dramatic instrument-frame look (the
 * matrix simulator). `pos` picks which corner.
 */
export function CornerBracket({
  pos,
  size = "sm",
  className,
}: {
  pos: "tl" | "tr" | "bl" | "br";
  size?: "sm" | "lg";
  className?: string;
}) {
  // Class names enumerated literally so the Tailwind JIT picks them
  // up from this file. Sizes map to:
  //   sm — 10×10, sits 1px outside the parent (composer chrome)
  //   lg — 12×12, sits 6px outside the parent (matrix simulator)
  const SIDES = {
    sm: {
      tl: "-left-px -top-px h-2.5 w-2.5 border-l border-t",
      tr: "-right-px -top-px h-2.5 w-2.5 border-r border-t",
      bl: "-bottom-px -left-px h-2.5 w-2.5 border-b border-l",
      br: "-bottom-px -right-px h-2.5 w-2.5 border-b border-r",
    },
    lg: {
      tl: "-left-1.5 -top-1.5 h-3 w-3 border-l border-t",
      tr: "-right-1.5 -top-1.5 h-3 w-3 border-r border-t",
      bl: "-bottom-1.5 -left-1.5 h-3 w-3 border-b border-l",
      br: "-bottom-1.5 -right-1.5 h-3 w-3 border-b border-r",
    },
  } as const;
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute z-10 border-(--color-border-strong) ${SIDES[size][pos]} ${className ?? ""}`}
    />
  );
}
