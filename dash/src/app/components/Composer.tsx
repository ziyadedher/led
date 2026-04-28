"use client";

import { motion } from "framer-motion";
import { useRef, useState } from "react";

import { ColorPicker, type ColorState } from "./ColorPicker";
import { EffectsPanel, type EffectsState } from "./EffectsPanel";

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

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
      className="rounded-2xl border border-(--color-border) bg-(--color-surface) p-5 shadow-2xl shadow-black/40"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="msg"
            className="block font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-dim)"
          >
            message
          </label>
          <div className="relative">
            <input
              id="msg"
              ref={inputRef}
              type="text"
              value={message}
              onChange={(e) => onMessageChange(e.target.value)}
              placeholder="say something"
              disabled={submitting}
              autoComplete="off"
              className="block w-full rounded-xl border border-(--color-border) bg-(--color-bg) px-4 py-3 font-mono text-base text-(--color-text) placeholder:text-(--color-text-dim) focus:border-(--color-accent) focus:outline-none focus:ring-0 disabled:opacity-60"
            />
            {message.length > 0 ? (
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-xs text-(--color-text-dim)">
                {message.length}
              </span>
            ) : null}
          </div>
        </div>

        <ColorPicker value={color} onChange={onColorChange} />
        <EffectsPanel
          value={effects}
          onChange={onEffectsChange}
          messageLength={message.length}
        />

        <button
          type="submit"
          disabled={disabled || submitting}
          className="group relative w-full overflow-hidden rounded-xl bg-(--color-accent) py-3 font-medium text-black shadow-(--shadow-glow) transition disabled:opacity-40 disabled:shadow-none"
        >
          <span className="relative z-10 inline-flex items-center justify-center gap-2 font-mono text-sm uppercase tracking-[0.2em]">
            {submitting ? "sending…" : "send to matrix"}
          </span>
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 transition group-hover:opacity-100 group-disabled:hidden"
          />
        </button>
      </form>
    </motion.section>
  );
}
