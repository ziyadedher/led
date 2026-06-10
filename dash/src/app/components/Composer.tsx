"use client";

import { useEffect, useRef, useState } from "react";

import { AccentButton } from "./AccentButton";
import { ColorPicker, type ColorState } from "./ColorPicker";
import { ComposerShell } from "./ComposerShell";
import { EffectsPanel, type EffectsState } from "./EffectsPanel";
import { Alert, MicroLabel, PixelValue } from "./ui";

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
  transmitFailed = false,
}: {
  message: string;
  onMessageChange: (s: string) => void;
  color: ColorState;
  onColorChange: (c: ColorState) => void;
  effects: EffectsState;
  onEffectsChange: (e: EffectsState) => void;
  onSubmit: () => Promise<void> | void;
  disabled: boolean;
  /** True when the last transmit threw. Surfaced as a status + banner;
   * cleared by the parent when the payload is edited. */
  transmitFailed?: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  // One-shot ACK stamp after a confirmed transmit; the NAK case is
  // covered by the transmitFailed Alert.
  const [acked, setAcked] = useState(false);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (ackTimer.current) clearTimeout(ackTimer.current);
    },
    [],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit();
      // Refocus only on confirmed success — onSubmit re-throws on
      // failure, so a throw skips this line. An unconditional refocus
      // would re-summon the mobile keyboard even when transmit failed.
      inputRef.current?.focus();
      setAcked(true);
      if (ackTimer.current) clearTimeout(ackTimer.current);
      ackTimer.current = setTimeout(() => setAcked(false), 1200);
    } catch {
      // Failure state is owned by the parent (transmitFailed); swallow
      // here so the rejection doesn't surface as an unhandled error.
    } finally {
      setSubmitting(false);
    }
  };

  const status = submitting
    ? "transmitting"
    : transmitFailed
      ? "transmit failed"
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
    // padded=false: the form owns its padding because the tape-stripes
    // overlay must cover the whole body, edge to edge.
    <ComposerShell
      title="composer"
      status={status}
      ariaLabel="Composer"
      padded={false}
    >
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
            <MicroLabel as="label" htmlFor="msg">
              payload
            </MicroLabel>
            <span
              id="msg-count"
              className="flex items-baseline gap-1 font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-text-faint)"
            >
              <PixelValue className={countTone}>
                {String(message.length).padStart(2, "0")}
              </PixelValue>
              <span aria-hidden>/</span>
              <PixelValue className="text-(--color-text-faint)">
                {String(MAX_LEN).padStart(2, "0")}
              </PixelValue>
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
              // Native maxLength is exposed to AT; the slice stays as
              // a backstop against programmatic over-long values.
              maxLength={MAX_LEN}
              onChange={(e) =>
                onMessageChange(e.target.value.slice(0, MAX_LEN))
              }
              placeholder="post something to the wall"
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="msg-count"
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

        {transmitFailed ? (
          <Alert>transmit failed · payload kept · retry</Alert>
        ) : null}

        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <AccentButton
              type="submit"
              glyph="▲"
              label={submitting ? "transmit ··· " : "transmit"}
              kbd="↵ enter"
              disabled={disabled || submitting}
            />
          </div>
          {/* One-shot ACK stamp on confirmed transmit. The slot is a
           * fixed-width span so the button never reflows; aria-hidden
           * because the role=status header already announces. */}
          <span
            aria-hidden
            className="flex w-9 shrink-0 justify-center"
          >
            <span
              className={[
                "border border-(--color-phosphor)/40 px-1.5 py-0.5",
                "font-pixel text-[12px] leading-none text-(--color-phosphor)",
                "transition-opacity duration-500",
                acked ? "opacity-100" : "opacity-0",
              ].join(" ")}
            >
              ACK
            </span>
          </span>
        </div>
      </form>
    </ComposerShell>
  );
}
