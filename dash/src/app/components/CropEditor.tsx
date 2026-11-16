"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Fader } from "./Fader";
import { FOCUS_RING, MicroLabel, PixelValue } from "./ui";

import {
  PANEL_H,
  PANEL_W,
  clampTransform,
  drawCrop,
  fillTransform,
  fitScale,
  fitTransform,
  makePanelCanvas,
  scaleBounds,
  zoomAbout,
  type CropTransform,
} from "@/utils/crop";

/** A decoded upload: one frame for a still, up to MAX_FRAMES for a gif. */
export type CropSource = {
  width: number;
  height: number;
  frames: { image: CanvasImageSource; delay_ms: number }[];
};

// The crop frame takes this fraction of the editor viewport; the rest
// is a dimmed margin showing what's being cut off.
const FRAME_FRACTION = 0.78;
// LED-dot preview geometry (CSS px): 3px dot + 1px gap → 256px.
const DOT = 3;
const DOT_GAP = 1;
const PREVIEW_PX = PANEL_W * (DOT + DOT_GAP);

/**
 * Pan / zoom / crop editor for image + gif uploads. The left pane is
 * the full source with the panel-shaped crop window in the middle
 * (drag to pan, pinch or scroll to zoom, arrow keys / +/- from the
 * keyboard). The right pane is a live LED-dot preview at panel
 * resolution, rendered by the same `drawCrop` that produces the
 * bitmap on apply — what you see is what ships.
 */
export function CropEditor({
  source,
  initial,
  busy,
  busyLabel,
  onApply,
  onCancel,
}: {
  source: CropSource;
  /** Transform to open with (e.g. the last applied crop); defaults to fit. */
  initial?: CropTransform;
  busy: boolean;
  busyLabel: string;
  onApply: (t: CropTransform) => void;
  onCancel: () => void;
}) {
  const { width: srcW, height: srcH, frames } = source;
  const [t, setT] = useState<CropTransform>(
    () => initial ?? fitTransform(srcW, srcH),
  );
  const [frameIdx, setFrameIdx] = useState(0);

  const viewRef = useRef<HTMLDivElement>(null);
  const viewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [viewSize, setViewSize] = useState(320);
  const panelCanvas = useRef<ReturnType<typeof makePanelCanvas> | null>(null);

  // Viewport px per panel px, and the crop frame's offset. Whole CSS
  // px so the dim-mask rects tile without antialiased seams.
  const framePx = Math.round(viewSize * FRAME_FRACTION);
  const k = framePx / PANEL_W;
  const off = Math.round((viewSize - framePx) / 2);

  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const update = () => setViewSize(Math.max(160, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animate gifs in both panes at native timing.
  useEffect(() => {
    if (frames.length < 2) return;
    const id = window.setTimeout(
      () => setFrameIdx((i) => (i + 1) % frames.length),
      frames[frameIdx]?.delay_ms ?? 100,
    );
    return () => window.clearTimeout(id);
  }, [frameIdx, frames]);

  // Paint the editor viewport: source through the transform, then a
  // dim mask outside the crop window, then the window outline.
  useEffect(() => {
    const canvas = viewCanvasRef.current;
    const frame = frames[frameIdx];
    if (!canvas || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(viewSize * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, viewSize, viewSize);
    // Faint tint inside the crop window so uncovered (unlit) panel
    // area reads differently from the surrounding margin.
    const f = PANEL_W * k;
    ctx.fillStyle = "#15151b";
    ctx.fillRect(off, off, f, f);
    const w = srcW * t.scale * k;
    const h = srcH * t.scale * k;
    ctx.imageSmoothingEnabled = t.scale * k < 2;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(frame.image, off + t.cx * k - w / 2, off + t.cy * k - h / 2, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, 0, viewSize, off);
    ctx.fillRect(0, off + f, viewSize, viewSize - off - f);
    ctx.fillRect(0, off, off, f);
    ctx.fillRect(off + f, off, viewSize - off - f, f);
    ctx.strokeStyle = "oklch(72.5% 0.17 52)";
    ctx.lineWidth = 1;
    ctx.strokeRect(off - 0.5, off - 0.5, f + 1, f + 1);
  }, [frames, frameIdx, t, viewSize, k, off, srcW, srcH]);

  // Paint the LED-dot preview from the exact panel-res crop.
  useEffect(() => {
    const canvas = previewRef.current;
    const frame = frames[frameIdx];
    if (!canvas || !frame) return;
    panelCanvas.current ??= makePanelCanvas();
    const { ctx: pctx } = panelCanvas.current;
    drawCrop(pctx, frame.image, srcW, srcH, t);
    const data = pctx.getImageData(0, 0, PANEL_W, PANEL_H).data;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(PREVIEW_PX * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, PREVIEW_PX, PREVIEW_PX);
    for (let y = 0; y < PANEL_H; y++) {
      for (let x = 0; x < PANEL_W; x++) {
        const i = (y * PANEL_W + x) * 4;
        // Alpha is binary on the panel: any non-zero alpha lights the
        // LED at full colour, zero leaves it dark.
        if (data[i + 3] === 0) {
          ctx.fillStyle = "#0b0b0e";
        } else {
          ctx.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
        }
        ctx.fillRect(
          x * (DOT + DOT_GAP) + DOT_GAP / 2,
          y * (DOT + DOT_GAP) + DOT_GAP / 2,
          DOT,
          DOT,
        );
      }
    }
  }, [frames, frameIdx, t, srcW, srcH]);

  // ── gestures ────────────────────────────────────────────────────
  // Live pointers (viewport-local CSS px). One pointer pans; two
  // pointers pinch-zoom about their midpoint and pan with it.
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = viewRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  // Viewport px → panel px.
  const toPanel = useCallback(
    (p: { x: number; y: number }) => ({ x: (p.x - off) / k, y: (p.y - off) / k }),
    [k, off],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, toLocal(e));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const map = pointers.current;
    const prev = map.get(e.pointerId);
    if (!prev) return;
    const next = toLocal(e);
    if (map.size === 1) {
      const dx = (next.x - prev.x) / k;
      const dy = (next.y - prev.y) / k;
      map.set(e.pointerId, next);
      setT((cur) =>
        clampTransform({ ...cur, cx: cur.cx + dx, cy: cur.cy + dy }, srcW, srcH),
      );
      return;
    }
    // Pinch: use this pointer's move against the first other pointer.
    const otherId = Array.from(map.keys()).find((id) => id !== e.pointerId);
    const other = otherId == null ? undefined : map.get(otherId);
    map.set(e.pointerId, next);
    if (!other) return;
    const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
    const d1 = Math.hypot(next.x - other.x, next.y - other.y);
    if (d0 < 1) return;
    const m0 = toPanel({ x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 });
    const m1 = toPanel({ x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 });
    setT((cur) => {
      const z = zoomAbout(cur, d1 / d0, m0.x, m0.y, srcW, srcH);
      return clampTransform(
        { ...z, cx: z.cx + (m1.x - m0.x), cy: z.cy + (m1.y - m0.y) },
        srcW,
        srcH,
      );
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };

  // Wheel / trackpad pinch (ctrl+wheel) zooms about the cursor. Needs
  // a non-passive native listener so we can stop the page scrolling.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (busy) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const p = toPanel({ x: e.clientX - r.left, y: e.clientY - r.top });
      const unit = e.deltaMode === 1 ? 16 : 1;
      const ratio = Math.exp((-e.deltaY * unit) / (e.ctrlKey ? 100 : 500));
      setT((cur) => zoomAbout(cur, ratio, p.x, p.y, srcW, srcH));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [busy, toPanel, srcW, srcH]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 8 : 1;
    const pan = (dx: number, dy: number) =>
      setT((cur) =>
        clampTransform({ ...cur, cx: cur.cx + dx, cy: cur.cy + dy }, srcW, srcH),
      );
    const zoom = (r: number) =>
      setT((cur) => zoomAbout(cur, r, PANEL_W / 2, PANEL_H / 2, srcW, srcH));
    switch (e.key) {
      case "ArrowLeft":
        pan(-step, 0);
        break;
      case "ArrowRight":
        pan(step, 0);
        break;
      case "ArrowUp":
        pan(0, -step);
        break;
      case "ArrowDown":
        pan(0, step);
        break;
      case "+":
      case "=":
        zoom(1.1);
        break;
      case "-":
      case "_":
        zoom(1 / 1.1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // ── zoom slider (log scale, relative to "fit") ──────────────────
  const fit = fitScale(srcW, srcH);
  const { min, max } = scaleBounds(srcW, srcH);
  const zoomLog = Math.log2(t.scale / fit);
  const setZoomLog = (v: number) =>
    setT((cur) =>
      zoomAbout(cur, (fit * 2 ** v) / cur.scale, PANEL_W / 2, PANEL_H / 2, srcW, srcH),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="w-full min-w-0 space-y-2 sm:max-w-[26rem] sm:flex-1">
          <MicroLabel>crop</MicroLabel>
          <div
            ref={viewRef}
            role="application"
            tabIndex={0}
            aria-label="Crop area. Drag to pan, pinch or scroll to zoom. Arrow keys pan, plus and minus zoom."
            aria-roledescription="crop editor"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            className={[
              "relative aspect-square w-full max-w-[26rem] cursor-grab touch-none select-none overflow-hidden border border-(--color-border) bg-black active:cursor-grabbing",
              FOCUS_RING,
            ].join(" ")}
          >
            <canvas
              ref={viewCanvasRef}
              aria-hidden
              className="pointer-events-none block h-full w-full"
            />
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
            drag to pan · pinch / scroll to zoom
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <MicroLabel>panel preview</MicroLabel>
            <PixelValue size="sm" className="text-(--color-text-dim)">
              {PANEL_W}×{PANEL_H}
            </PixelValue>
          </div>
          <canvas
            ref={previewRef}
            role="img"
            aria-label="Panel-resolution preview of the crop"
            className="block border border-(--color-border) bg-black"
            style={{ width: PREVIEW_PX, height: PREVIEW_PX, maxWidth: "100%", aspectRatio: "1" }}
          />
        </div>
      </div>

      <Fader
        label="zoom"
        value={zoomLog}
        min={Math.log2(min / fit)}
        max={Math.log2(max / fit)}
        step={0.01}
        onChange={setZoomLog}
        format={(v) => `${(2 ** v).toFixed(2)}x`}
        endpoints={["out", "in"]}
        ariaLabel="Crop zoom"
      />

      <div className="flex flex-wrap items-center gap-2">
        <ChipButton onClick={() => setT(fitTransform(srcW, srcH))} disabled={busy}>
          fit
        </ChipButton>
        <ChipButton onClick={() => setT(fillTransform(srcW, srcH))} disabled={busy}>
          fill
        </ChipButton>
        <ChipButton
          onClick={() =>
            setT((cur) => ({ ...cur, cx: PANEL_W / 2, cy: PANEL_H / 2 }))
          }
          disabled={busy}
        >
          center
        </ChipButton>
        <span className="flex-1" />
        <ChipButton onClick={onCancel} disabled={busy}>
          cancel
        </ChipButton>
        <button
          type="button"
          onClick={() => onApply(t)}
          disabled={busy}
          aria-busy={busy}
          className={[
            "border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-2",
            "font-mono text-xs uppercase tracking-[0.3em] text-(--color-accent)",
            "transition hover:bg-(--color-accent)/20 disabled:cursor-not-allowed disabled:opacity-50",
            FOCUS_RING,
          ].join(" ")}
        >
          {busy ? busyLabel : "apply"}
        </button>
      </div>
    </div>
  );
}

/**
 * Shown after applying while the upload is still in memory: reopen
 * the editor on the same source at the last-applied crop.
 */
export function AdjustCropButton({
  name,
  onClick,
}: {
  name: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <ChipButton onClick={onClick}>adjust crop</ChipButton>
      <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
        {name}
      </span>
    </div>
  );
}

function ChipButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "border border-(--color-border) px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-muted)",
        "transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-50",
        FOCUS_RING,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
