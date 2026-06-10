"use client";

import { MicroLabel } from "./ui";

/**
 * Instrument checkbox row — square check, one size, one focus
 * treatment. Replaces three hand-rolled copies (per-letter phase,
 * depth shade, paint grid) that had drifted in size and ring-offset.
 */
export function CheckRow({
  label,
  hint,
  checked,
  onChange,
  sigil = true,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Set false for compact inline rows (e.g. paint's grid toggle). */
  sigil?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <MicroLabel sigil={sigil}>{label}</MicroLabel>
        {hint ? (
          <span className="font-mono text-[9px] tracking-wide text-(--color-text-faint)">
            {hint}
          </span>
        ) : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded-[1px] border-(--color-border-strong) bg-(--color-bg) text-(--color-accent) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--color-bg)"
      />
    </label>
  );
}
