"use client";

import { useRef } from "react";

/**
 * Roving-tabindex keyboard model for a `role="radiogroup"` of
 * arbitrary tiles — the same contract SegmentedToggle implements for
 * text pills, shared so the glyph/icon tile groups (paint tools,
 * shape picker, test patterns) stop advertising radio semantics they
 * don't honor.
 *
 * Usage:
 *   const radio = useRovingRadio(ids, value, onChange);
 *   <div role="radiogroup" aria-label=… onKeyDown={radio.onKeyDown}>
 *     {options.map((o, i) => (
 *       <button {...radio.itemProps(o.id, i)} …visuals… />
 *     ))}
 *   </div>
 *
 * Arrow keys move + select the neighbour (selection follows focus,
 * the standard radio model); Home/End jump to the ends. Only the
 * checked tile sits in the Tab order.
 */
export function useRovingRadio<T extends string>(
  ids: readonly T[],
  value: T,
  onChange: (next: T) => void,
) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (index: number) => {
    const id = ids[index];
    if (id === undefined) return;
    onChange(id);
    refs.current[index]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const current = Math.max(0, ids.indexOf(value));
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        select((current + 1) % ids.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        select((current - 1 + ids.length) % ids.length);
        break;
      case "Home":
        e.preventDefault();
        select(0);
        break;
      case "End":
        e.preventDefault();
        select(ids.length - 1);
        break;
    }
  };

  const itemProps = (id: T, index: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      refs.current[index] = el;
    },
    type: "button" as const,
    role: "radio" as const,
    "aria-checked": id === value,
    tabIndex: id === value ? 0 : -1,
    onClick: () => onChange(id),
  });

  return { onKeyDown, itemProps };
}
