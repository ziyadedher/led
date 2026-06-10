"use client";

/**
 * Shared instrument-language primitives. These encode the recipes
 * that were previously copy-pasted (and drifting) across the app:
 * the `:: label` micro-label, the VT323 pixel readout, the square
 * status lamp, the danger banner, the empty/overlay state block, and
 * the canonical focus ring.
 */

/** Canonical focus treatment for interactive chrome. Append
 * `focus-visible:ring-inset` when the element sits flush in a group. */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent)";

/** The `:: label` micro-label classes, for places that need the raw
 * recipe (e.g. as a <label htmlFor>). Prefer <MicroLabel>. */
export const MICRO_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)";

/**
 * Uppercase tracked micro-label with the `::` sigil — the one section
 * label of the design language (the stray `//` variant is retired).
 */
export function MicroLabel({
  children,
  as: Tag = "span",
  htmlFor,
  sigil = true,
  className,
}: {
  children: React.ReactNode;
  as?: "span" | "label" | "div";
  htmlFor?: string;
  /** Set false for inline uses where the `::` would be noise. */
  sigil?: boolean;
  className?: string;
}) {
  return (
    <Tag
      htmlFor={htmlFor}
      className={`${MICRO_LABEL_CLASS} ${className ?? ""}`}
    >
      {sigil ? ":: " : null}
      {children}
    </Tag>
  );
}

const PIXEL_SIZE = {
  sm: "text-[12px]",
  md: "text-[14px]",
  lg: "text-[16px]",
  xl: "text-2xl",
} as const;

/**
 * VT323 numeric/glyph readout. Replaces the 19 ad-hoc
 * `style={{ fontFamily: "var(--font-pixel)" }}` call sites; sizes
 * collapse to three roles — sm: chip glyphs, md: standard readout,
 * lg: telemetry value, xl: the header wordmark.
 */
export function PixelValue({
  size = "md",
  className,
  children,
}: {
  size?: keyof typeof PIXEL_SIZE;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`font-pixel leading-none tabular-nums ${PIXEL_SIZE[size]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export type LampTone = "phosphor" | "accent" | "amber" | "danger" | "faint";

const LAMP_TONE: Record<LampTone, { bg: string; glow: string | null }> = {
  phosphor: { bg: "bg-(--color-phosphor)", glow: "var(--color-phosphor)" },
  accent: { bg: "bg-(--color-accent)", glow: "var(--color-accent)" },
  amber: { bg: "bg-(--color-amber)", glow: "var(--color-amber)" },
  danger: { bg: "bg-(--color-danger)", glow: "var(--color-danger)" },
  faint: { bg: "bg-(--color-text-faint)", glow: null },
};

/**
 * Square status lamp — the deliberate instrument-panel cue (LED
 * package, not a web dot). One geometry everywhere; previously split
 * between rounded-full and rounded-[1px] copies.
 */
export function Lamp({
  tone,
  pulse = false,
  glow = true,
  className,
}: {
  tone: LampTone;
  pulse?: boolean;
  /** Render the colored halo (skip for quiet/inactive lamps). */
  glow?: boolean;
  className?: string;
}) {
  const t = LAMP_TONE[tone];
  return (
    <span
      aria-hidden
      className={[
        "inline-block h-1.5 w-1.5 shrink-0 rounded-[1px]",
        t.bg,
        pulse ? "animate-pulse" : "",
        className ?? "",
      ].join(" ")}
      style={glow && t.glow ? { boxShadow: `0 0 6px ${t.glow}` } : undefined}
    />
  );
}

/**
 * Canonical danger banner. role="alert" is built in so async failures
 * (transmit, decode, reorder) are announced — three of the six
 * previous hand-rolled copies forgot it.
 */
export function Alert({
  children,
  center = false,
  className,
}: {
  children: React.ReactNode;
  center?: boolean;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={[
        "border border-(--color-danger)/40 bg-(--color-danger)/5 px-3 py-2",
        "font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-danger)",
        center ? "text-center" : "",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </p>
  );
}

/**
 * Stacked title + detail state block. `block` is the bordered
 * empty-state card, `overlay` floats over the simulator, `dashed` is
 * the compact side-rail variant.
 */
export function EmptyState({
  title,
  detail,
  variant = "block",
  tone = "default",
  className,
}: {
  title: string;
  detail?: string;
  variant?: "block" | "overlay" | "dashed";
  /** `danger` renders the title in the danger tone (offline states). */
  tone?: "default" | "danger";
  className?: string;
}) {
  const chrome = {
    block:
      "flex flex-col items-center gap-2 border border-dashed border-(--color-border) bg-(--color-surface)/40 px-4 py-10 text-center",
    overlay:
      "pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 text-center backdrop-blur-[1px]",
    dashed:
      "flex flex-col items-center gap-1 border border-dashed border-(--color-border) px-2 py-3 text-center",
  }[variant];
  const titleSize = variant === "overlay" ? "text-[11px]" : "text-[10px]";
  const titleTone =
    tone === "danger" ? "text-(--color-danger)" : "text-(--color-text-dim)";

  return (
    <div className={`${chrome} font-mono uppercase ${className ?? ""}`}>
      <p className={`${titleSize} tracking-[0.3em] ${titleTone}`}>{title}</p>
      {detail ? (
        <p className="text-[9px] tracking-[0.25em] text-(--color-text-faint)">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
