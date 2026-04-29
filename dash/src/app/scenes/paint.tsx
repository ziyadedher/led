"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type ImageSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { panels } from "@/utils/actions";
import { type Rgb } from "@/utils/color";

const PANEL_W = 64;
const PANEL_H = 64;
const MAX_RECENT = 8;

/**
 * Paint mode produces the same shape as image mode (RGB888 row-major
 * bitmap). The driver renders both via Mode::Image — the only thing
 * that distinguishes paint is this composer. Reusing the parser so
 * legacy/upload-shaped configs still hydrate cleanly.
 */
export { parseImageConfig as parsePaintConfig } from "./image";

type Tool = "brush" | "fill" | "eraser" | "eyedrop";

export function PaintComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: ImageSceneConfig;
}) {
  const [bitmap, setBitmap] = useState<Uint8ClampedArray>(
    () => bitmapFrom(config) ?? new Uint8ClampedArray(PANEL_W * PANEL_H * 3),
  );

  // Snapshot of what we last persisted, so the sync-from-config
  // effect below can ignore "the server told us back what we just
  // pushed". Without it, our own writes would round-trip through
  // realtime and clobber any in-flight stroke.
  const lastPushedRef = useRef<string | null>(null);
  // Sticky flag during a pointer-down stroke so an incoming server
  // update doesn't yank the canvas out from under the user.
  const strokeInFlightRef = useRef(false);

  // External-update sync: when `config` changes (server pushed a
  // newer bitmap, e.g. another tab edited), refresh local state —
  // unless we're mid-stroke or the new payload is exactly what we
  // just sent.
  useEffect(() => {
    const next = bitmapFrom(config);
    if (!next) return;
    if (strokeInFlightRef.current) return;
    const fingerprint = configFingerprint(config);
    if (fingerprint === lastPushedRef.current) return;
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
  const [color, setColor] = useState<Rgb>({ r: 255, g: 138, b: 44 });
  const [grid, setGrid] = useState(true);

  // Per-instance recents; previously a module-level array which
  // bled history across panel switches and mutated outside React's
  // render cycle (so the swatch row only updated when something
  // else happened to rerender).
  const [recentColors, setRecentColors] = useState<Rgb[]>([]);
  const rememberColor = useCallback((c: Rgb) => {
    setRecentColors((prev) => {
      const filtered = prev.filter(
        (r) => !(r.r === c.r && r.g === c.g && r.b === c.b),
      );
      return [c, ...filtered].slice(0, MAX_RECENT);
    });
  }, []);

  const persist = useCallback(
    (next: Uint8ClampedArray) => {
      const arr = Array.from(next);
      const config: ImageSceneConfig = {
        width: PANEL_W,
        height: PANEL_H,
        bitmap: arr,
      };
      lastPushedRef.current = configFingerprint(config);
      void panels.setMode.call(panelId, "paint", config);
    },
    [panelId],
  );

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
            {recentColors.map((c, i) => (
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

/** Stable fingerprint of an image config. Used by the sync effect to
 * skip our own round-tripped writes — `JSON.stringify` is fine here
 * because the bitmap was already a plain array at persist time. */
function configFingerprint(config: ImageSceneConfig): string {
  return `${config.width}x${config.height}:${config.bitmap.length}:${config.bitmap[0] ?? 0}:${config.bitmap[config.bitmap.length - 1] ?? 0}:${config.bitmap.reduce((a, b) => (a + b) | 0, 0)}`;
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
        ref={canvasRef}
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
