"use client";

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ColorState } from "./ColorPicker";

import { PanelContext } from "@/app/context";
import { entries as entriesActions } from "@/utils/actions";

// Matches the driver's matrix (rpi-led-panel default is 64×64 + AdafruitHatPwm)
// and embedded_graphics::mono_font::ascii::FONT_5X8 with character_spacing=1.
const ROWS = 64;
const COLS = 64;
const GLYPH_W = 5;
const GLYPH_H = 8;
const CHAR_PITCH = GLYPH_W + 1; // FONT_5X8 character_spacing == 1
const LINE_PITCH = GLYPH_H + 1; // driver adds 1 row of gap between lines
const SCROLL_VISIBLE = Math.floor(ROWS / LINE_PITCH);
const GAP = 1;

type WireColor =
  | { Rgb: { r: number; g: number; b: number } }
  | { Rainbow: { is_per_letter: boolean; speed: number } };

const DEFAULT_COLOR: WireColor = { Rgb: { r: 255, g: 138, b: 44 } };

type PreviewEntry = {
  text: string;
  color: ColorState;
};

/**
 * Faux LED matrix: renders the panel's currently-visible entries (or a
 * live composer preview, when provided) onto a 64×32 grid of soft pixels.
 * Adaptive: cell size scales to fit the container width.
 */
export function MatrixPreview({ preview }: { preview?: PreviewEntry } = {}) {
  const panelId = useContext(PanelContext);
  const entriesData = entriesActions.get.useSWR(panelId);
  const scrollData = entriesActions.scroll.get.useSWR(panelId);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(640);

  useLayoutEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const update = () => setContainerWidth(wrap.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const scroll = scrollData.data?.scroll ?? 0;
  const items = useMemo(
    () => entriesData.data?.entries ?? [],
    [entriesData.data?.entries],
  );
  const visible = useMemo<{ text: string; color: WireColor }[]>(() => {
    const fromStore = items
      .slice(scroll, scroll + SCROLL_VISIBLE)
      .map((e) => ({
        text: e.data?.text ?? "",
        color: e.data?.options?.color ?? DEFAULT_COLOR,
      }));
    if (!preview) return fromStore;
    const previewWire: WireColor =
      preview.color.mode === "rgb"
        ? { Rgb: preview.color.rgb }
        : {
            Rainbow: {
              is_per_letter: preview.color.perLetter,
              speed: preview.color.speed,
            },
          };
    return [
      { text: preview.text, color: previewWire },
      ...fromStore.slice(0, SCROLL_VISIBLE - 1),
    ];
  }, [items, scroll, preview]);
  const fromStoreEmpty = items.length === 0;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    // Pick the largest integer cell size that fits container width, capped so
    // the preview doesn't dominate the page on wide displays.
    const padding = 24; // matches the wrapper p-3 (=12px each side).
    const target = Math.max(120, containerWidth - padding);
    const fit = Math.max(3, Math.floor((target - GAP) / COLS) - 1);
    const cell = Math.min(6, fit);
    const w = COLS * (cell + GAP) + GAP;
    const h = ROWS * (cell + GAP) + GAP;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);

    const radius = cell / 2;

    // Unlit pixels.
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const x = GAP + col * (cell + GAP) + radius;
        const y = GAP + r * (cell + GAP) + radius;
        ctx.beginPath();
        ctx.arc(x, y, radius - 0.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.035)";
        ctx.fill();
      }
    }

    // Lit pixels per visible entry.
    visible.forEach((entry, lineIdx) => {
      const text = entry.text;
      const color = wireColorToCss(entry.color);
      const lineY = lineIdx * LINE_PITCH + 1;
      let cursor = 0;
      for (const ch of text.toUpperCase()) {
        const glyph = FONT_5x8[ch] ?? FONT_5x8[" "];
        for (let row = 0; row < GLYPH_H; row++) {
          for (let col = 0; col < GLYPH_W; col++) {
            if ((glyph[row] >> (GLYPH_W - 1 - col)) & 1) {
              const cx = cursor + col;
              const cy = lineY + row;
              if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;
              const x = GAP + cx * (cell + GAP) + radius;
              const y = GAP + cy * (cell + GAP) + radius;
              ctx.beginPath();
              ctx.arc(x, y, radius - 0.5, 0, Math.PI * 2);
              ctx.fillStyle = color;
              ctx.shadowColor = color;
              ctx.shadowBlur = Math.max(4, cell);
              ctx.fill();
            }
          }
        }
        cursor += CHAR_PITCH;
      }
    });
    ctx.shadowBlur = 0;
  }, [visible, containerWidth]);

  return (
    <div
      ref={wrapperRef}
      className="relative overflow-hidden rounded-2xl border border-(--color-border) bg-black p-3 shadow-2xl shadow-black/60"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.65))]"
      />
      <canvas
        ref={canvasRef}
        aria-label="LED matrix preview"
        className="relative mx-auto block"
      />
      {preview && preview.text.length === 0 && fromStoreEmpty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          matrix idle
        </div>
      ) : null}
    </div>
  );
}

function wireColorToCss(color: WireColor): string {
  if ("Rgb" in color) {
    const { r, g, b } = color.Rgb;
    return `rgb(${r}, ${g}, ${b})`;
  }
  return "#ff8a2c";
}

// 5x8 ASCII bitmap — each row is a uint5 (top 5 bits used).
// Visually mirrors embedded_graphics::mono_font::ascii::FONT_5X8 closely
// enough for a preview (we hand-tuned these from the canonical 5x7 BIOS
// bitmaps with an extra empty row on top for the 8-row glyph cell).
// For pixel-perfect parity we'd compile the driver to WASM.
const FONT_5x8: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0, 0],
  "!": [0, 0x04, 0x04, 0x04, 0x04, 0, 0x04, 0],
  "?": [0, 0x0e, 0x11, 0x01, 0x06, 0x04, 0, 0x04],
  ".": [0, 0, 0, 0, 0, 0, 0x04, 0],
  ",": [0, 0, 0, 0, 0, 0x04, 0x04, 0x08],
  ":": [0, 0, 0x04, 0, 0, 0x04, 0, 0],
  "-": [0, 0, 0, 0, 0x0e, 0, 0, 0],
  "/": [0, 0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "'": [0, 0x04, 0x04, 0x08, 0, 0, 0, 0],
  "\"": [0, 0x0a, 0x0a, 0x0a, 0, 0, 0, 0],
  "(": [0, 0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0, 0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "&": [0, 0x06, 0x09, 0x09, 0x06, 0x09, 0x09, 0x16],
  "@": [0, 0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0e],
  "#": [0, 0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  "+": [0, 0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  "=": [0, 0, 0, 0x1f, 0, 0x1f, 0, 0],
  "0": [0, 0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0, 0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0, 0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0, 0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0, 0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0, 0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0, 0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0, 0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0, 0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0, 0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0, 0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0, 0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0, 0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0, 0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0, 0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0, 0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0, 0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0, 0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0, 0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0, 0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0, 0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0, 0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0, 0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0, 0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0, 0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0, 0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0, 0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0, 0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0, 0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0, 0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0, 0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0, 0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
};
