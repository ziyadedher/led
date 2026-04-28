"use client";

import { forwardRef } from "react";

/**
 * Thin button wrapper. Tailwind v4 dropped the preflight rule that
 * gave `<button>` a pointer cursor, and our buttons are styled
 * differently each — variants here just pick a base palette so we
 * don't repeat hover/border/disabled scaffolding everywhere.
 *
 * Global `cursor: pointer` lives in globals.css so even hand-rolled
 * `<button>` elements stay clicky; this component is for the cases
 * where we want a consistent visual variant on top.
 */
type Variant = "ghost" | "outline" | "transport" | "primary";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  // Bare button — picks up text color from context, hover row tint.
  ghost:
    "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
  // Outlined chip — used for transport-style toggles.
  outline:
    "border border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)",
  // Transport: the live/paused/offline pill on the simulator chrome.
  transport: "border border-(--color-border) hover:bg-(--color-surface-2)",
  // Primary call-to-action — the transmit button.
  primary:
    "border border-(--color-accent)/60 bg-(--color-accent)/10 text-(--color-accent) hover:bg-(--color-accent)/20 hover:shadow-[0_0_24px_-8px_var(--color-accent-fade)]",
};

const SIZES: Record<Size, string> = {
  sm: "px-2 py-1 text-[10px]",
  md: "px-3 py-2 text-xs",
};

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "ghost", size = "sm", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      className={[
        "inline-flex items-center gap-2 font-mono uppercase tracking-[0.3em] transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-60",
        VARIANTS[variant],
        SIZES[size],
        className ?? "",
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
});
