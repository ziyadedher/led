"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import {
  DEFAULT_IMAGE_CONFIG,
  type ImageSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { panels } from "@/utils/actions";
import { type Rgb } from "@/utils/color";

const PANEL_W = 64;
const PANEL_H = 64;

/**
 * Paint mode produces the same shape as image mode (RGB888 row-major
 * bitmap). The driver renders both via Mode::Image — the only thing
 * that distinguishes paint is this composer. Reusing the parser so
 * legacy/upload-shaped configs still hydrate cleanly.
 */
export { parseImageConfig as parsePaintConfig } from "./image";

type Tool = "brush" | "fill" | "eraser" | "eyedrop";

const RECENT_COLORS: Rgb[] = [];
const MAX_RECENT = 8;

function rememberColor(c: Rgb) {
  // Drop any existing copy then prepend, keep last N.
  const idx = RECENT_COLORS.findIndex(
    (r) => r.r === c.r && r.g === c.g && r.b === c.b,
  );
  if (idx >= 0) RECENT_COLORS.splice(idx, 1);
  RECENT_COLORS.unshift(c);
  if (RECENT_COLORS.length > MAX_RECENT) RECENT_COLORS.length = MAX_RECENT;
}

export function PaintComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: ImageSceneConfig;
}) {
  // Hydrate the canvas from the saved config the first time we see
  // it; subsequent server-side updates only sync if the bitmap
  // identity changed (deep compare via length + sentinel pixels).
  const initialBitmap = useMemo(
    () => bitmapFrom(config) ?? new Uint8ClampedArray(PANEL_W * PANEL_H * 3),
    [config],
  );
  const [bitmap, setBitmap] = useState<Uint8ClampedArray>(initialBitmap);

  // Per-stroke undo stack — snapshot the bitmap at pointerdown.
  const undoStack = useRef<Uint8ClampedArray[]>([]);
  const redoStack = useRef<Uint8ClampedArray[]>([]);

  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState<Rgb>({ r: 255, g: 138, b: 44 });
  const [grid, setGrid] = useState(true);

  const persist = useCallback(
    (next: Uint8ClampedArray) => {
      // Convert to plain number[] for JSON; the bitmap field is
      // declared as number[] in the types contract.
      const arr = Array.from(next);
      void panels.setMode.call(panelId, "paint", {
        width: PANEL_W,
        height: PANEL_H,
        bitmap: arr,
      });
    },
    [panelId],
  );

  // Save a checkpoint, returning a *fresh* mutable copy to draw into.
  const beginStroke = () => {
    undoStack.current.push(new Uint8ClampedArray(bitmap));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current.length = 0;
    return new Uint8ClampedArray(bitmap);
  };

  const commit = (next: Uint8ClampedArray) => {
    setBitmap(next);
    persist(next);
  };

  const handlePixel = (next: Uint8ClampedArray, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= PANEL_W || y >= PANEL_H) return;
    if (tool === "brush") {
      writePx(next, x, y, color);
    } else if (tool === "eraser") {
      writePx(next, x, y, { r: 0, g: 0, b: 0 });
    } else if (tool === "fill") {
      const target = readPx(next, x, y);
      if (sameColor(target, color)) return;
      floodFill(next, x, y, target, color);
    } else if (tool === "eyedrop") {
      const picked = readPx(next, x, y);
      setColor(picked);
      rememberColor(picked);
    }
  };

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(new Uint8ClampedArray(bitmap));
    commit(prev);
  };

  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(new Uint8ClampedArray(bitmap));
    commit(next);
  };

  const clear = () => {
    const next = beginStroke();
    next.fill(0);
    commit(next);
  };

  return (
    <ComposerShell title="paint" status="64×64 pixel editor" ariaLabel="Paint configuration">
      <div className="space-y-4 px-4 py-4">
        {/* Tool row */}
        <div className="flex flex-wrap items-center gap-2">
          <ToolGroup
            tool={tool}
            onChange={(t) => {
              setTool(t);
              if (t === "brush") rememberColor(color);
            }}
          />
          <span aria-hidden className="flex-1" />
          <SmallButton onClick={undo} disabled={undoStack.current.length === 0}>
            undo
          </SmallButton>
          <SmallButton onClick={redo} disabled={redoStack.current.length === 0}>
            redo
          </SmallButton>
          <SmallButton onClick={clear} variant="danger">
            clear
          </SmallButton>
        </div>

        {/* Canvas */}
        <PaintCanvas
          bitmap={bitmap}
          grid={grid}
          onStrokeBegin={beginStroke}
          onStrokeStep={(working, x, y) => {
            handlePixel(working, x, y);
            // Trigger a re-render mid-stroke for paint-trail feedback,
            // but DON'T persist on every pointer move — only on
            // stroke end. This keeps Supabase happy.
            setBitmap(new Uint8ClampedArray(working));
          }}
          onStrokeEnd={(working) => commit(working)}
        />

        {/* Grid + recent colours */}
        <div className="flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={grid}
              onChange={(e) => setGrid(e.target.checked)}
              className="h-3 w-3 rounded-[1px] border-(--color-border-strong) bg-(--color-bg) text-(--color-accent) focus:ring-0 focus:ring-offset-0"
            />
            grid
          </label>
          <div className="flex flex-wrap items-center gap-1">
            {RECENT_COLORS.map((c, i) => (
              <button
                key={`${c.r}-${c.g}-${c.b}-${i}`}
                type="button"
                onClick={() => setColor(c)}
                className="h-4 w-4 border border-(--color-border) hover:border-(--color-text)"
                style={{ background: `rgb(${c.r},${c.g},${c.b})` }}
                aria-label={`Pick rgb(${c.r},${c.g},${c.b})`}
              />
            ))}
          </div>
        </div>

        <div className="border-t border-dashed border-(--color-hairline)" />

        <SolidColorPicker
          value={color}
          onChange={(next) => {
            setColor(next);
            rememberColor(next);
          }}
        />
      </div>
    </ComposerShell>
  );
}

/* ─── canvas ──────────────────────────────────────────────────────── */

function PaintCanvas({
  bitmap,
  grid,
  onStrokeBegin,
  onStrokeStep,
  onStrokeEnd,
}: {
  bitmap: Uint8ClampedArray;
  grid: boolean;
  onStrokeBegin: () => Uint8ClampedArray;
  onStrokeStep: (working: Uint8ClampedArray, x: number, y: number) => void;
  onStrokeEnd: (working: Uint8ClampedArray) => void;
}) {
  // Fixed render size — keep it square and centered, rescale to fit
  // the available width via aspect-ratio + max-width on the wrapper.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workingRef = useRef<Uint8ClampedArray | null>(null);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);

  // Repaint canvas whenever the bitmap changes. Cell size derived
  // from the canvas's actual rendered width to stay crisp on resize.
  const repaint = useCallback(
    (canvas: HTMLCanvasElement, source: Uint8ClampedArray) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssSize = canvas.clientWidth || 384;
      canvas.width = Math.round(cssSize * dpr);
      canvas.height = Math.round(cssSize * dpr);
      const cell = (cssSize * dpr) / PANEL_W;
      ctx.imageSmoothingEnabled = false;

      // Background — checkered, dim.
      ctx.fillStyle = "#0d0d11";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Pixels.
      for (let y = 0; y < PANEL_H; y++) {
        for (let x = 0; x < PANEL_W; x++) {
          const idx = (y * PANEL_W + x) * 3;
          const r = source[idx];
          const g = source[idx + 1];
          const b = source[idx + 2];
          if (r || g || b) {
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5);
          }
        }
      }

      // Grid overlay every cell, slightly heavier every 8.
      if (grid) {
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1;
        for (let i = 1; i < PANEL_W; i++) {
          const p = Math.round(i * cell) + 0.5;
          ctx.beginPath();
          ctx.moveTo(p, 0);
          ctx.lineTo(p, canvas.height);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, p);
          ctx.lineTo(canvas.width, p);
          ctx.stroke();
        }
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        for (let i = 8; i < PANEL_W; i += 8) {
          const p = Math.round(i * cell) + 0.5;
          ctx.beginPath();
          ctx.moveTo(p, 0);
          ctx.lineTo(p, canvas.height);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, p);
          ctx.lineTo(canvas.width, p);
          ctx.stroke();
        }
      }
    },
    [grid],
  );

  // Run once + on every bitmap/grid change.
  if (canvasRef.current) {
    repaint(canvasRef.current, bitmap);
  }

  const cellAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * PANEL_W);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * PANEL_H);
    return { x, y };
  };

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const working = onStrokeBegin();
    workingRef.current = working;
    const { x, y } = cellAt(e);
    lastCellRef.current = { x, y };
    onStrokeStep(working, x, y);
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!workingRef.current) return;
    const { x, y } = cellAt(e);
    const last = lastCellRef.current;
    if (last && last.x === x && last.y === y) return;
    // Bresenham between last and current to avoid skipping cells on
    // fast drags.
    if (last) {
      drawLine(last.x, last.y, x, y, (px, py) =>
        onStrokeStep(workingRef.current!, px, py),
      );
    } else {
      onStrokeStep(workingRef.current, x, y);
    }
    lastCellRef.current = { x, y };
  };

  const handleUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (workingRef.current) onStrokeEnd(workingRef.current);
    workingRef.current = null;
    lastCellRef.current = null;
  };

  return (
    <div className="mx-auto aspect-square w-full max-w-[384px] border border-(--color-border) bg-(--color-bg)">
      <canvas
        ref={(c) => {
          canvasRef.current = c;
          if (c) repaint(c, bitmap);
        }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        className="block h-full w-full touch-none cursor-crosshair"
        aria-label="Paint canvas"
      />
    </div>
  );
}

/* ─── tool group ──────────────────────────────────────────────────── */

function ToolGroup({
  tool,
  onChange,
}: {
  tool: Tool;
  onChange: (t: Tool) => void;
}) {
  const tools: { id: Tool; glyph: string; label: string }[] = [
    { id: "brush", glyph: "✎", label: "brush" },
    { id: "fill", glyph: "▣", label: "fill" },
    { id: "eraser", glyph: "▢", label: "erase" },
    { id: "eyedrop", glyph: "◉", label: "pick" },
  ];
  return (
    <div className="flex items-center gap-px border border-(--color-border)">
      {tools.map((t) => {
        const active = t.id === tool;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            title={t.label}
            aria-label={t.label}
            aria-pressed={active}
            className={[
              "flex h-7 items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors",
              active
                ? "bg-(--color-accent)/15 text-(--color-accent)"
                : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
            ].join(" ")}
          >
            <span aria-hidden style={{ fontSize: 13 }}>
              {t.glyph}
            </span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SmallButton({
  onClick,
  disabled,
  variant,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variant === "danger"
          ? "border-(--color-danger)/40 text-(--color-danger)/80 hover:bg-(--color-danger)/10 hover:text-(--color-danger)"
          : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* ─── bitmap helpers ──────────────────────────────────────────────── */

function bitmapFrom(config: ImageSceneConfig): Uint8ClampedArray | null {
  if (
    config.width !== PANEL_W ||
    config.height !== PANEL_H ||
    config.bitmap.length !== PANEL_W * PANEL_H * 3
  ) {
    // If the saved config is from upload-mode (smaller image), we
    // can't reliably reconstruct a paint bitmap from it. Start blank.
    return null;
  }
  return new Uint8ClampedArray(config.bitmap);
}

function readPx(buf: Uint8ClampedArray, x: number, y: number): Rgb {
  const idx = (y * PANEL_W + x) * 3;
  return { r: buf[idx], g: buf[idx + 1], b: buf[idx + 2] };
}

function writePx(buf: Uint8ClampedArray, x: number, y: number, c: Rgb) {
  const idx = (y * PANEL_W + x) * 3;
  buf[idx] = c.r;
  buf[idx + 1] = c.g;
  buf[idx + 2] = c.b;
}

function sameColor(a: Rgb, b: Rgb) {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function floodFill(
  buf: Uint8ClampedArray,
  x: number,
  y: number,
  target: Rgb,
  replace: Rgb,
) {
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop()!;
    if (px < 0 || py < 0 || px >= PANEL_W || py >= PANEL_H) continue;
    if (!sameColor(readPx(buf, px, py), target)) continue;
    writePx(buf, px, py, replace);
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
}

function drawLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  put: (x: number, y: number) => void,
) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  // Cap iterations defensively — shouldn't happen on a 64x64 grid
  // but we don't want a malformed pointer event hanging the UI.
  for (let i = 0; i < 200; i++) {
    put(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
