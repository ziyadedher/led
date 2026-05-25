"use client";

import { useEffect } from "react";

/**
 * Route-root error boundary. A malformed `mode_config` (or any render
 * throw) is contained here instead of blanking the whole dashboard.
 * Styled to match the dark instrument chrome; offers a reset that
 * re-attempts the failed render subtree.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for diagnostics — the boundary swallows it otherwise.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col items-center justify-center px-4 sm:px-6 lg:px-10">
      <section
        role="alert"
        aria-label="Dashboard error"
        className="relative w-full max-w-md border border-(--color-danger)/40 bg-(--color-surface)/70 backdrop-blur-sm"
      >
        <header className="flex items-center justify-between border-b border-(--color-danger)/30 bg-(--color-danger)/5 px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-danger)">
            :: fault
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
            render halted
          </span>
        </header>

        <div className="space-y-4 px-4 py-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
            the dashboard hit an unrecoverable error
          </p>
          <p className="break-words font-mono text-xs text-(--color-text-muted)">
            {error.message || "unknown error"}
            {error.digest ? (
              <span className="ml-2 text-(--color-text-faint)">
                · {error.digest}
              </span>
            ) : null}
          </p>

          <button
            type="button"
            onClick={reset}
            className="group flex w-full items-center justify-between overflow-hidden border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-3 text-(--color-accent) transition hover:bg-(--color-accent)/20"
          >
            <span className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-6 w-6 items-center justify-center border border-(--color-accent)/40"
                style={{
                  fontFamily: "var(--font-pixel)",
                  fontSize: 16,
                  lineHeight: 1,
                }}
              >
                ↻
              </span>
              <span className="font-mono text-xs uppercase tracking-[0.4em]">
                retry
              </span>
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] opacity-70">
              re-render
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
