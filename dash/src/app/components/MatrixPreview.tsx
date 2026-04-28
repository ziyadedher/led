"use client";

import { useContext, useEffect, useRef } from "react";

import { entries as entriesActions } from "@/utils/actions";
import { PanelContext } from "@/app/context";

const ROWS = 32;
const COLS = 64;
const SCROLL_VISIBLE = 7;

/**
 * Faux LED matrix preview. Renders the panel's currently-visible entries
 * to a 64×32 grid of soft circular pixels. Doesn't claim to be
 * pixel-accurate to what the Pi renders — it's a vibe check that the
 * dash and the matrix are looking at the same data.
 *
 * Uses canvas + a tiny 5×7 ASCII bitmap font so we don't have to ship
 * an actual font atlas.
 */
export function MatrixPreview() {
  const panelId = useContext(PanelContext);
  const entriesData = entriesActions.get.useSWR(panelId);
  const scrollData = entriesActions.scroll.get.useSWR(panelId);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const scroll = scrollData.data?.scroll ?? 0;
  const items = entriesData.data?.entries ?? [];
  const visible = items.slice(scroll, scroll + SCROLL_VISIBLE);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const cell = 8;
    const gap = 1;
    const w = COLS * (cell + gap) + gap;
    const h = ROWS * (cell + gap) + gap;
    c.width = w * window.devicePixelRatio;
    c.height = h * window.devicePixelRatio;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    ctx.clearRect(0, 0, w, h);

    // Draw all unlit pixels first.
    for (let r = 0; r < ROWS; r++) {
      for (let c0 = 0; c0 < COLS; c0++) {
        const x = gap + c0 * (cell + gap) + cell / 2;
        const y = gap + r * (cell + gap) + cell / 2;
        ctx.beginPath();
        ctx.arc(x, y, cell / 2 - 0.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fill();
      }
    }

    // Draw lit pixels per entry.
    visible.forEach((entry, lineIdx) => {
      const text = entry.data.text;
      const color = wireColorToCss(entry.data.options.color);
      const lineY = lineIdx * 4 + 2;
      let cursor = 1;
      for (const ch of text.toUpperCase()) {
        const glyph = FONT_5x7[ch] ?? FONT_5x7[" "];
        for (let row = 0; row < 7; row++) {
          for (let col = 0; col < 5; col++) {
            if ((glyph[row] >> (4 - col)) & 1) {
              const cx = cursor + col;
              const cy = lineY + row;
              if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;
              const x = gap + cx * (cell + gap) + cell / 2;
              const y = gap + cy * (cell + gap) + cell / 2;
              ctx.beginPath();
              ctx.arc(x, y, cell / 2 - 0.5, 0, Math.PI * 2);
              ctx.fillStyle = color;
              ctx.shadowColor = color;
              ctx.shadowBlur = 6;
              ctx.fill();
              ctx.shadowBlur = 0;
            }
          }
        }
        cursor += 6;
      }
    });
  }, [visible]);

  return (
    <div className="relative overflow-x-auto rounded-2xl border border-[--color-border] bg-black p-3">
      <canvas ref={canvasRef} aria-label="LED matrix preview" />
    </div>
  );
}

function wireColorToCss(
  color:
    | { Rgb: { r: number; g: number; b: number } }
    | { Rainbow: { is_per_letter: boolean; speed: number } },
): string {
  if ("Rgb" in color) {
    const { r, g, b } = color.Rgb;
    return `rgb(${r}, ${g}, ${b})`;
  }
  // Rough rainbow approximation: pick a vivid orange.
  return "#ff8a2c";
}

// 5x7 ASCII bitmap font — each row is a uint5 (top 5 bits used).
// Source: hand-typed minimum set of characters likely to appear in
// matrix messages. Missing characters fall back to space.
const FONT_5x7: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "!": [0x04, 0x04, 0x04, 0x04, 0, 0x04, 0],
  "?": [0x0e, 0x11, 0x01, 0x06, 0x04, 0, 0x04],
  ".": [0, 0, 0, 0, 0, 0x04, 0],
  ",": [0, 0, 0, 0, 0x04, 0x04, 0x08],
  ":": [0, 0x04, 0, 0, 0x04, 0, 0],
  "-": [0, 0, 0, 0x0e, 0, 0, 0],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
};
