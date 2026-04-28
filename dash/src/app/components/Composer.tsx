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

  return (
    <ComposerShell title="composer" status={status} ariaLabel="Composer">
      <form onSubmit={handleSubmit} className="space-y-5 px-4 py-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="msg"
              className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)"
            >
              :: payload
            </label>
            <span className="font-mono text-[10px] tabular-nums text-(--color-text-faint)">
              {String(message.length).padStart(2, "0")}/
              {String(MAX_LEN).padStart(2, "0")}
            </span>
          </div>
          <div className="flex items-center gap-2 border-b border-(--color-border-strong) pb-1.5 focus-within:border-(--color-accent)">
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
              placeholder="say something to the wall"
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              className="w-full border-0 bg-transparent p-0 font-mono text-base text-(--color-text) placeholder:text-(--color-text-faint) focus:outline-none focus:ring-0 disabled:opacity-60"
            />
            {message.length === 0 ? (
              <span
                aria-hidden
                className="animate-cursor select-none font-mono text-base text-(--color-accent)"
              >
                ▌
              </span>
            ) : null}
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
          className="group relative flex w-full items-center justify-between overflow-hidden border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-3 text-(--color-accent) transition hover:bg-(--color-accent)/20 disabled:cursor-not-allowed disabled:border-(--color-border) disabled:bg-transparent disabled:text-(--color-text-faint)"
        >
          <span className="font-mono text-xs uppercase tracking-[0.4em]">
            {submitting ? "transmit ··· " : "transmit"}
          </span>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] opacity-70">
            <span>↵ enter</span>
            <span aria-hidden className="text-base">
              →
            </span>
          </span>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/15 to-transparent transition-all duration-700 group-hover:left-full group-disabled:hidden"
          />
        </button>
      </form>
    </ComposerShell>
  );
}
