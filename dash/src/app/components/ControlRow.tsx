"use client";

import { MicroLabel } from "./ui";

/**
 * Labeled control row: `:: label` (plus optional faint hint line) on
 * the left, the control on the right. Promoted from clock.tsx's
 * private Row — life and shapes re-implemented the same layout.
 */
export function ControlRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <MicroLabel>{label}</MicroLabel>
        {hint ? (
          <span className="font-mono text-[9px] tracking-wide text-(--color-text-faint)">
            {hint}
          </span>
        ) : null}
      </span>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}
