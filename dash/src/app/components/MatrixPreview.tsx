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

// 64×64 to match the rpi-led-panel default; the WASM core runs the same
// embedded_graphics::FONT_5X8 + marquee/rainbow logic the driver does.
const ROWS = 64;
const COLS = 64;
// Adafruit P3 (#4732) uses small SMD packages on a 3mm pitch — visually
// the LED is ~60-70% of the cell, the rest dark mask. Picking gap=2,
// cell-cap=3 gives the right "small bright dot in a black grid" feel.
const GAP = 2;
const CELL_CAP = 3;

type WireColor =
  | { Rgb: { r: number; g: number; b: number } }
  | { Rainbow: { is_per_letter: boolean; speed: number } };

type Frame = {
  entries: { text: string; options: { color: WireColor; marquee: { speed: number } } }[];
  panel: {
    scroll: number;
    is_paused: boolean;
    flash: { is_active: boolean; on_steps: number; total_steps: number };
  };
};

type PreviewEntry = {
  text: string;
  color: ColorState;
  marqueeSpeed: number;
};

const DEFAULT_COLOR: WireColor = { Rgb: { r: 255, g: 138, b: 44 } };
const FLASH_OFF = { is_active: false, on_steps: 0, total_steps: 0 };

/**
 * Bit-exact LED-matrix simulator. Loads the driver's render core
 * compiled to WASM and ticks it on requestAnimationFrame, blitting
 * the resulting RGBA buffer through ImageData onto a square-LED
 * canvas. Same code path as the Pi: marquee scroll, rainbow,
 * flash all behave identically.
 */
export function MatrixPreview({ preview }: { preview?: PreviewEntry } = {}) {
  const panelId = useContext(PanelContext);
  const entriesData = entriesActions.get.useSWR(panelId);
  const scrollData = entriesActions.scroll.get.useSWR(panelId);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(640);
  const rendererRef = useRef<WasmRenderer | null>(null);

  useLayoutEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const update = () => setContainerWidth(wrap.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Load the WASM module once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mod = await import("wasm-sim");
      if (cancelled) return;
      rendererRef.current = new mod.Renderer(COLS, ROWS);
    })();
    return () => {
      cancelled = true;
      rendererRef.current?.free();
      rendererRef.current = null;
    };
  }, []);

  const items = useMemo(
    () => entriesData.data?.entries ?? [],
    [entriesData.data?.entries],
  );
  const scroll = scrollData.data?.scroll ?? 0;

  // Build the Frame the WASM renderer consumes. Live preview becomes
  // the first entry, then real entries from Supabase.
  const frame = useMemo<Frame>(() => {
    const fromStore = items.map((e) => ({
      text: e.data?.text ?? "",
      options: {
        color: (e.data?.options?.color ?? DEFAULT_COLOR) as WireColor,
        marquee: { speed: e.data?.options?.marquee?.speed ?? 0 },
      },
    }));
    if (preview && preview.text.length > 0) {
      const previewWire: WireColor =
        preview.color.mode === "rgb"
          ? { Rgb: preview.color.rgb }
          : {
              Rainbow: {
                is_per_letter: preview.color.perLetter,
                speed: preview.color.speed,
              },
            };
      return {
        entries: [
          {
            text: preview.text,
            options: {
              color: previewWire,
              marquee: { speed: preview.marqueeSpeed },
            },
          },
          ...fromStore,
        ],
        panel: { scroll, is_paused: false, flash: FLASH_OFF },
      };
    }
    return {
      entries: fromStore,
      panel: { scroll, is_paused: false, flash: FLASH_OFF },
    };
  }, [items, preview, scroll]);

  // Push state into the renderer whenever it changes.
  useEffect(() => {
    rendererRef.current?.setFrameJson(JSON.stringify(frame));
  }, [frame]);

  // rAF loop: tick the WASM renderer and paint to canvas. Cell size
  // adapts to container width; the matrix is 64×64 logical pixels
  // upscaled to discrete LEDs with a 1px gap and slight corner radius.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const padding = 24;
    const target = Math.max(120, containerWidth - padding);
    const fit = Math.max(2, Math.floor((target - GAP) / COLS) - GAP);
    const cell = Math.min(CELL_CAP, fit);
    const w = COLS * (cell + GAP) + GAP;
    const h = ROWS * (cell + GAP) + GAP;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cornerRadius = Math.max(0.5, cell * 0.18);
    const unlitFill = "rgba(255,255,255,0.05)";

    let raf = 0;
    const draw = () => {
      const renderer = rendererRef.current;
      let pixels: Uint8Array | null = null;
      try {
        pixels = renderer?.tick() ?? null;
      } catch {
        // Renderer not yet initialized or transient error — fall through
        // to drawing the unlit grid.
      }

      ctx.clearRect(0, 0, w, h);

      // Pass 1: unlit substrate. Cheap, no glow.
      ctx.shadowBlur = 0;
      ctx.fillStyle = unlitFill;
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          if (pixels) {
            const idx = (row * COLS + col) * 4;
            if (pixels[idx] || pixels[idx + 1] || pixels[idx + 2]) continue;
          }
          const x = GAP + col * (cell + GAP);
          const y = GAP + row * (cell + GAP);
          ctx.beginPath();
          ctx.roundRect(x, y, cell, cell, cornerRadius);
          ctx.fill();
        }
      }

      if (!pixels) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // Pass 2: lit LEDs as a soft outer halo. Real LEDs at full
      // brightness bloom well past their package — gamma-curved so
      // dim LEDs barely glow and bright ones spill into neighbors.
      ctx.globalCompositeOperation = "lighter";
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const idx = (row * COLS + col) * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];
          if (!r && !g && !b) continue;

          const intensity = Math.max(r, g, b) / 255;
          const haloRadius = cell * 0.4 + cell * 2.2 * Math.pow(intensity, 1.4);
          const cx = GAP + col * (cell + GAP) + cell / 2;
          const cy = GAP + row * (cell + GAP) + cell / 2;
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloRadius);
          const alpha = 0.35 * Math.pow(intensity, 1.2);
          grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
          grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(cx - haloRadius, cy - haloRadius, haloRadius * 2, haloRadius * 2);
        }
      }

      // Pass 3: the LED chip itself — bright, slightly inset, with a
      // small brighter core that reads as the actual die.
      ctx.globalCompositeOperation = "source-over";
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const idx = (row * COLS + col) * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];
          if (!r && !g && !b) continue;

          const x = GAP + col * (cell + GAP);
          const y = GAP + row * (cell + GAP);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.beginPath();
          ctx.roundRect(x, y, cell, cell, cornerRadius);
          ctx.fill();

          // Tiny hot core — only visible when LED is actually bright.
          const intensity = Math.max(r, g, b) / 255;
          if (intensity > 0.5) {
            const corePad = cell * 0.3;
            ctx.fillStyle = `rgba(255,255,255,${(intensity - 0.5) * 0.5})`;
            ctx.fillRect(x + corePad, y + corePad, cell - corePad * 2, cell - corePad * 2);
          }
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [containerWidth]);

  const matrixIdle =
    preview &&
    preview.text.length === 0 &&
    items.length === 0;

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
        aria-label="LED matrix simulator"
        className="relative mx-auto block"
      />
      {matrixIdle ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          matrix idle
        </div>
      ) : null}
    </div>
  );
}

// Minimal type for what we actually use from the wasm module — keeps
// the `Renderer` reference typed without pulling the full wasm types
// into the component file.
type WasmRenderer = {
  setFrameJson(json: string): void;
  tick(): Uint8Array;
  free(): void;
};
