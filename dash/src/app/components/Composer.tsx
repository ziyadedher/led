"use client";

import { useRef, useState } from "react";

import { ColorPicker, type ColorState } from "./ColorPicker";
import { ComposerShell } from "./ComposerShell";
import { EffectsPanel, type EffectsState } from "./EffectsPanel";

const MAX_LEN = 64;

export function Composer({
  message,
  onMessageChange,
  color,
  onColorChange,
  effects,
  onEffectsChange,
  onSubmit,
  disabled,
}: {
  message: string;
  onMessageChange: (s: string) => void;
  color: ColorState;
  onColorChange: (c: ColorState) => void;
  effects: EffectsState;
  onEffectsChange: (e: EffectsState) => void;
  onSubmit: () => Promise<void> | void;
  disabled: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit();
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const status = submitting
    ? "transmitting"
    : disabled
      ? "awaiting payload"
      : "ready / press ↵";

  const countTone =
    message.length === 0
      ? "text-(--color-text-faint)"
      : message.length >= MAX_LEN - 6
        ? "text-(--color-danger)"
        : message.length >= MAX_LEN - 16
          ? "text-(--color-amber)"
          : "text-(--color-phosphor)";

  return (
    <ComposerShell title="composer" status={status} ariaLabel="Composer">
      <form
        onSubmit={handleSubmit}
        className={[
          "relative space-y-5 px-4 py-4",
          submitting ? "tape-stripes" : "",
        ].join(" ")}
      >
        {/* Marching tape during submit */}
        {submitting ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-[var(--animate-tape)] tape-stripes"
          />
        ) : null}

        {/* Payload row — terminal prompt, big pixel-font counter */}
        <div className="space-y-2">
          <div className="flex items-end justify-between">
            <label
              htmlFor="msg"
              className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)"
            >
              :: payload
            </label>
            <span className="flex items-baseline gap-1 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-text-faint)">
              <span
                className={`tabular-nums ${countTone}`}
                style={{ fontFamily: "var(--font-pixel)", fontSize: 14 }}
              >
                {String(message.length).padStart(2, "0")}
              </span>
              <span aria-hidden>/</span>
              <span
                className="tabular-nums text-(--color-text-faint)"
                style={{ fontFamily: "var(--font-pixel)", fontSize: 14 }}
              >
                {String(MAX_LEN).padStart(2, "0")}
              </span>
              <span className="ml-1 normal-case lowercase">chars</span>
            </span>
          </div>
          <div className="relative flex items-center gap-2 border-b border-(--color-border-strong) pb-1.5 focus-within:border-(--color-accent)">
            <span
              aria-hidden
              className="font-mono text-base text-(--color-accent)"
            >
              ▸
            </span>
            <input
              id="msg"
              ref={inputRef}
              type="text"
              value={message}
              onChange={(e) =>
                onMessageChange(e.target.value.slice(0, MAX_LEN))
              }
              placeholder="post something to the wall"
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              className="w-full border-0 bg-transparent p-0 font-mono text-base text-(--color-text) placeholder:text-(--color-text-faint) focus:outline-none focus:ring-0 disabled:opacity-60"
            />
            {message.length === 0 ? (
              <span
                aria-hidden
                className="animate-[var(--animate-cursor)] select-none font-mono text-base text-(--color-accent)"
              >
                ▌
              </span>
            ) : null}

            {/* Length progress bar — sits below the input as a thin
             * meter, pegged colour matches the counter tone. */}
            <span
              aria-hidden
              className="pointer-events-none absolute -bottom-px left-0 h-px bg-(--color-accent) transition-[width,background-color]"
              style={{
                width: `${(message.length / MAX_LEN) * 100}%`,
                background:
                  message.length >= MAX_LEN - 6
                    ? "var(--color-danger)"
                    : message.length >= MAX_LEN - 16
                      ? "var(--color-amber)"
                      : "var(--color-accent)",
              }}
            />
          </div>
        </div>

        <div className="border-t border-dashed border-(--color-hairline)" />

        <ColorPicker value={color} onChange={onColorChange} />

        <div className="border-t border-dashed border-(--color-hairline)" />

        <EffectsPanel
          value={effects}
          onChange={onEffectsChange}
          messageLength={message.length}
        />

        <div className="border-t border-dashed border-(--color-hairline)" />

        <button
          type="submit"
          disabled={disabled || submitting}
          className="group relative flex w-full items-center justify-between overflow-hidden border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-3 text-(--color-accent) transition hover:bg-(--color-accent)/20 hover:shadow-[0_0_24px_-8px_var(--color-accent-fade)] disabled:cursor-not-allowed disabled:border-(--color-border) disabled:bg-transparent disabled:text-(--color-text-faint) disabled:hover:shadow-none"
        >
          {/* Left: launch glyph + label */}
          <span className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-6 w-6 items-center justify-center border border-(--color-accent)/40 group-disabled:border-(--color-border)"
              style={{
                fontFamily: "var(--font-pixel)",
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ▲
            </span>
            <span className="font-mono text-xs uppercase tracking-[0.4em]">
              {submitting ? "transmit ··· " : "transmit"}
            </span>
          </span>

          {/* Right: keybind hint */}
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] opacity-70">
            <kbd className="border border-(--color-accent)/30 bg-(--color-bg)/50 px-1.5 py-0.5 group-disabled:border-(--color-border)">
              ↵ enter
            </kbd>
          </span>

          {/* Sweep highlight on hover — like a tape head passing over */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/15 to-transparent transition-all duration-700 group-hover:left-full group-disabled:hidden"
          />
        </button>
      </form>
    </ComposerShell>
  );
}
