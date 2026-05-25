"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { parseImageConfig } from "./image";
import { type ImageSceneConfig } from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { panels } from "@/utils/actions";
import { LED_ORANGE, parseRgb, type Rgb } from "@/utils/color";

const PANEL_W = 64;
const PANEL_H = 64;
const MAX_RECENT = 8;
const DEFAULT_COLOR: Rgb = LED_ORANGE;

/**
 * Paint mode produces the same shape as image mode (RGB888 row-major
 * bitmap) plus a persisted working `color`. The driver renders both
 * via Mode::Image — the only thing that distinguishes paint is this
 * composer. The persisted `color` (ignored by the renderer) lets the
 * brush colour survive a reopen.
 */
export type PaintSceneConfig = ImageSceneConfig & { color?: Rgb };

/** Parse paint config: the image bitmap plus the sticky brush colour. */
export function parsePaintConfig(raw: unknown): PaintSceneConfig {
  const base = parseImageConfig(raw);
  let color: Rgb | undefined;
  if (raw && typeof raw === "object") {
    const c = (raw as Record<string, unknown>).color;
    if (c && typeof c === "object") color = parseRgb(c, LED_ORANGE);
  }
  return { ...base, color };
}

type Tool = "brush" | "fill" | "eraser" | "eyedrop";

export function PaintComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: PaintSceneConfig;
}) {
  const [bitmap, setBitmap] = useState<Uint8ClampedArray>(
    () => bitmapFrom(config) ?? new Uint8ClampedArray(PANEL_W * PANEL_H * 4),
  );

  // Snapshot (full byte copy) of what we last persisted, so the
  // sync-from-config effect can ignore "the server told us back what
  // we just pushed". A robust content comparison — the old fingerprint
  // (length + first/last byte + rolling sum) collided easily, which
  // could silently drop a real external update OR let a stale echo
  // clobber a fresh local stroke.
  const lastPushedRef = useRef<Uint8ClampedArray | null>(null);
  // Sticky flag during a pointer/keyboard stroke so an incoming server
  // update doesn't yank the canvas out from under the user.
  const strokeInFlightRef = useRef(false);

  // External-update sync: when `config` changes (server pushed a
  // newer bitmap, e.g. another tab edited), refresh local state —
  // unless we're mid-stroke or the new payload is exactly what we
  // just sent (compared byte-for-byte).
  useEffect(() => {
    const next = bitmapFrom(config);
    if (!next) return;
    if (strokeInFlightRef.current) return;
    if (lastPushedRef.current && bytesEqual(next, lastPushedRef.current)) return;
    setBitmap(next);
  }, [config]);

  // Undo/redo lengths in state so the buttons' disabled prop stays
  // truthful — the stacks themselves live in refs because mutating
  // them shouldn't normally rerender.
  const undoStack = useRef<Uint8ClampedArray[]>([]);
  const redoStack = useRef<Uint8ClampedArray[]>([]);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);
  const syncStackLengths = () => {
    setUndoLen(undoStack.current.length);
    setRedoLen(redoStack.current.length);
  };

  const [tool, setTool] = useState<Tool>("brush");
  // Sticky brush colour, hydrated from the persisted config so a
  // reopen restores it.
  const [color, setColor] = useState<Rgb>(config.color ?? DEFAULT_COLOR);
  const [grid, setGrid] = useState(true);

  // Per-instance recent-color list; cleared on panel switch.
  const [recentColors, setRecentColors] = useState<Rgb[]>([]);
  const rememberColor = (c: Rgb) => {
    setRecentColors((prev) => {
      const filtered = prev.filter(
        (r) => !(r.r === c.r && r.g === c.g && r.b === c.b),
      );
      return [c, ...filtered].slice(0, MAX_RECENT);
    });
  };

  // Persist a bitmap (+ the sticky brush colour) to mode_config. The
  // colour rides along so reopening the editor restores it.
  const persist = (next: Uint8ClampedArray, persistColor: Rgb) => {
    const cfg: PaintSceneConfig = {
      width: PANEL_W,
      height: PANEL_H,
      bitmap: Array.from(next),
      color: persistColor,
    };
    // Store the exact bytes we're shipping for the echo guard.
    lastPushedRef.current = new Uint8ClampedArray(next);
    void panels.setMode.call(
      panelId,
      "paint",
      cfg as unknown as Record<string, unknown>,
    );
  };

  const beginStroke = () => {
    strokeInFlightRef.current = true;
    undoStack.current.push(new Uint8ClampedArray(bitmap));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current.length = 0;
    syncStackLengths();
    return new Uint8ClampedArray(bitmap);
  };

  const commit = (next: Uint8ClampedArray) => {
    strokeInFlightRef.current = false;
    setBitmap(next);
    persist(next, color);
  };

  const handlePixel = (next: Uint8ClampedArray, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= PANEL_W || y >= PANEL_H) return;
    if (tool === "brush") {
      writePx(next, x, y, { ...color, a: 255 });
    } else if (tool === "eraser") {
      writePx(next, x, y, { r: 0, g: 0, b: 0, a: 0 });
    } else if (tool === "fill") {
      const target = readPx(next, x, y);
      const replace = { ...color, a: 255 };
      if (samePixel(target, replace)) return;
      floodFill(next, x, y, target, replace);
    } else if (tool === "eyedrop") {
      const picked = readPx(next, x, y);
      // Eyedrop on a transparent pixel is a no-op — the color picker
      // doesn't model alpha, so we'd just be making up a colour.
      if (picked.a === 0) return;
      const rgb: Rgb = { r: picked.r, g: picked.g, b: picked.b };
      setColor(rgb);
      rememberColor(rgb);
    }
  };

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(new Uint8ClampedArray(bitmap));
    syncStackLengths();
    commit(prev);
  };

  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(new Uint8ClampedArray(bitmap));
    syncStackLengths();
    commit(next);
  };

  const clear = () => {
    const next = beginStroke();
    next.fill(0);
    commit(next);
  };

  // Single-cell stroke (keyboard paint) — runs the full begin→step→
  // commit cycle so it shares undo/persist with pointer strokes.
  const paintCell = (x: number, y: number) => {
    const working = beginStroke();
    handlePixel(working, x, y);
    commit(working);
  };

  // Set + persist the sticky brush colour (without touching the
  // bitmap) so reopening the editor restores the last-used colour.
  const changeColor = (next: Rgb) => {
    setColor(next);
    rememberColor(next);
    persist(bitmap, next);
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
          <SmallButton onClick={undo} disabled={undoLen === 0}>
            undo
          </SmallButton>
          <SmallButton onClick={redo} disabled={redoLen === 0}>
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
            // Persisting only on stroke-end — Supabase write rate
            // limit + driver ConfigCache invalidation make per-pixel
            // writes a thrash trap. Mid-stroke we just bump local
            // state for the paint-trail feedback.
            setBitmap(new Uint8ClampedArray(working));
          }}
          onStrokeEnd={(working) => commit(working)}
          onPaintCell={paintCell}
        />

        {/* Grid + recent colours */}
        <div className="flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={grid}
              onChange={(e) => setGrid(e.target.checked)}
              className="h-3 w-3 rounded-[1px] border-(--color-border-strong) bg-(--color-bg) text-(--color-accent) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--color-bg)"
            />
            grid
          </label>
          <div className="flex flex-wrap items-center gap-1">
            {recentColors.map((c, i) => (
              <button
                key={`${c.r}-${c.g}-${c.b}-${i}`}
                type="button"
                onClick={() => changeColor(c)}
                className="h-4 w-4 border border-(--color-border) hover:border-(--color-text) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent)"
                style={{ background: `rgb(${c.r},${c.g},${c.b})` }}
                aria-label={`Pick rgb(${c.r},${c.g},${c.b})`}
              />
            ))}
          </div>
        </div>

        <div className="border-t border-dashed border-(--color-hairline)" />

        <SolidColorPicker value={color} onChange={changeColor} />
      </div>
    </ComposerShell>
  );
}

/** True if two byte arrays are identical in length and content. */
function bytesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* ─── canvas ──────────────────────────────────────────────────────── */

function PaintCanvas({
  bitmap,
  grid,
  onStrokeBegin,
  onStrokeStep,
  onStrokeEnd,
  onPaintCell,
}: {
  bitmap: Uint8ClampedArray;
  grid: boolean;
  onStrokeBegin: () => Uint8ClampedArray;
  onStrokeStep: (working: Uint8ClampedArray, x: number, y: number) => void;
  onStrokeEnd: (working: Uint8ClampedArray) => void;
  onPaintCell: (x: number, y: number) => void;
}) {
  // Fixed render size — keep it square and centered, rescale to fit
  // the available width via aspect-ratio + max-width on the wrapper.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workingRef = useRef<Uint8ClampedArray | null>(null);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);

  // Keyboard cursor position. Arrows move it; Enter/Space paint the
  // cell under it. Rendered as a highlighted outline so it's visible.
  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Repaint canvas whenever the bitmap (or cursor/grid) changes. Cell
  // size derived from the canvas's actual rendered width to stay crisp.
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
          const idx = (y * PANEL_W + x) * 4;
          if (source[idx + 3] === 0) continue;
          const r = source[idx];
          const g = source[idx + 1];
          const b = source[idx + 2];
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5);
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

  // Repaint via effect — running it during render would mutate
  // canvas dimensions inside React's render phase, which strict
  // mode and concurrent rendering both complain about.
  useEffect(() => {
    if (canvasRef.current) {
      repaint(canvasRef.current, bitmap);
    }
  }, [bitmap, repaint]);

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
    setCursor({ x, y });
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

  // Keyboard model: arrows move the cursor (clamped to the grid),
  // Enter/Space paint the cell under it. The wrapper is focusable.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        setCursor((c) => ({ ...c, x: Math.max(0, c.x - 1) }));
        break;
      case "ArrowRight":
        e.preventDefault();
        setCursor((c) => ({ ...c, x: Math.min(PANEL_W - 1, c.x + 1) }));
        break;
      case "ArrowUp":
        e.preventDefault();
        setCursor((c) => ({ ...c, y: Math.max(0, c.y - 1) }));
        break;
      case "ArrowDown":
        e.preventDefault();
        setCursor((c) => ({ ...c, y: Math.min(PANEL_H - 1, c.y + 1) }));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onPaintCell(cursor.x, cursor.y);
        break;
    }
  };

  // Cursor outline as a CSS overlay so it doesn't fight the canvas's
  // own repaint cycle. Position is a percentage of the grid.
  const cursorStyle: React.CSSProperties = {
    left: `${(cursor.x / PANEL_W) * 100}%`,
    top: `${(cursor.y / PANEL_H) * 100}%`,
    width: `${(1 / PANEL_W) * 100}%`,
    height: `${(1 / PANEL_H) * 100}%`,
  };

  return (
    <div
      role="application"
      aria-label="Paint canvas — arrow keys move the cursor, Enter or Space paints"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="relative mx-auto aspect-square w-full max-w-[384px] border border-(--color-border) bg-(--color-bg) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent)"
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        className="block h-full w-full touch-none cursor-crosshair"
        aria-hidden
      />
      <span
        aria-hidden
        className="pointer-events-none absolute border border-(--color-accent) shadow-[0_0_4px_var(--color-accent)]"
        style={cursorStyle}
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
    <div role="radiogroup" aria-label="Tool" className="flex items-center gap-px border border-(--color-border)">
      {tools.map((t) => {
        const active = t.id === tool;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            onClick={() => onChange(t.id)}
            title={t.label}
            aria-label={t.label}
            aria-checked={active}
            className={[
              "flex h-7 items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) focus-visible:ring-inset",
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
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent)",
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

type Pixel = { r: number; g: number; b: number; a: number };

function bitmapFrom(config: ImageSceneConfig): Uint8ClampedArray | null {
  // Only reuse upload-shaped configs that match the paint canvas
  // exactly (64×64 RGBA). Smaller uploads can't be reconstructed
  // into the paint grid; treat as blank.
  if (
    config.width !== PANEL_W ||
    config.height !== PANEL_H ||
    config.bitmap.length !== PANEL_W * PANEL_H * 4
  ) {
    return null;
  }
  return new Uint8ClampedArray(config.bitmap);
}

function readPx(buf: Uint8ClampedArray, x: number, y: number): Pixel {
  const idx = (y * PANEL_W + x) * 4;
  return { r: buf[idx], g: buf[idx + 1], b: buf[idx + 2], a: buf[idx + 3] };
}

function writePx(buf: Uint8ClampedArray, x: number, y: number, c: Pixel) {
  const idx = (y * PANEL_W + x) * 4;
  buf[idx] = c.r;
  buf[idx + 1] = c.g;
  buf[idx + 2] = c.b;
  buf[idx + 3] = c.a;
}

function samePixel(a: Pixel, b: Pixel) {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function floodFill(
  buf: Uint8ClampedArray,
  x: number,
  y: number,
  target: Pixel,
  replace: Pixel,
) {
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop()!;
    if (px < 0 || py < 0 || px >= PANEL_W || py >= PANEL_H) continue;
    if (!samePixel(readPx(buf, px, py), target)) continue;
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
