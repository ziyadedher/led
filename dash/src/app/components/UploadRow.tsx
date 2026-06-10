"use client";

import { useRef } from "react";

import { FOCUS_RING, MicroLabel } from "./ui";

/**
 * Shared upload control for the image / gif composers: `:: upload`
 * label, accent choose-file button, hidden input, filename/status
 * readout. The two scenes previously duplicated this verbatim
 * (including an accidental mb-7).
 */
export function UploadRow({
  accept,
  idleLabel,
  busyLabel,
  busy,
  status,
  onFile,
}: {
  accept: string;
  idleLabel: string;
  /** Label while `busy` — e.g. "decoding…" / "transmitting…". */
  busyLabel: string;
  busy: boolean;
  /** Right-side readout: filename · dims, or the empty-state text. */
  status: string;
  onFile: (file: File) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <div className="mb-3">
        <MicroLabel>upload</MicroLabel>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-busy={busy}
          className={[
            "border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-2",
            "font-mono text-xs uppercase tracking-[0.3em] text-(--color-accent)",
            "transition hover:bg-(--color-accent)/20 disabled:cursor-not-allowed disabled:opacity-50",
            FOCUS_RING,
          ].join(" ")}
        >
          {busy ? busyLabel : idleLabel}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = "";
          }}
        />
        <span
          role="status"
          className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)"
        >
          {status}
        </span>
      </div>
    </div>
  );
}
