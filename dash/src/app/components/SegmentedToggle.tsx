"use client";

import { useId, useRef } from "react";

export type SegmentOption<T extends string> = {
  id: T;
  label: string;
  /** Optional tooltip / longer description. */
  blurb?: string;
};

/**
 * Shared "pick one of N" control — a `role="radiogroup"` of pill
 * segments with the dark-instrument aesthetic. Replaces the divergent
 * hand-rolled toggle idioms across the editors (clock H12/H24, seconds
 * on/off, meridiem, …).
 *
 * Keyboard model: roving tabindex (only the active segment is in the
 * tab order); Left/Up and Right/Down move + select the neighbour,
 * Home/End jump to the ends. Visible focus ring on each segment.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  const groupId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (delta: number) => {
    const idx = options.findIndex((o) => o.id === value);
    const start = idx < 0 ? 0 : idx;
    const next = (start + delta + options.length) % options.length;
    onChange(options[next].id);
    refs.current[next]?.focus();
  };

  const jump = (to: 0 | -1) => {
    const next = to === 0 ? 0 : options.length - 1;
    onChange(options[next].id);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        jump(0);
        break;
      case "End":
        e.preventDefault();
        jump(-1);
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex items-center gap-px border border-(--color-border)"
    >
      {options.map((o, i) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            id={`${groupId}-${o.id}`}
            title={o.blurb}
            onClick={() => onChange(o.id)}
            className={[
              "px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) focus-visible:ring-inset",
              active
                ? "bg-(--color-accent) text-black"
                : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
