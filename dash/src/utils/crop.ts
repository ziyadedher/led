/**
 * Pan/zoom crop math shared by the image + gif upload editors.
 *
 * A crop is a similarity transform from source pixels into panel
 * pixels: the source is drawn `scale` panel-px per source-px, with its
 * centre at (`cx`, `cy`) in panel coordinates. Everything the editor
 * does (drag, pinch, wheel, fit/fill buttons) just edits these three
 * numbers; `renderCrop` turns them into the panel bitmap.
 *
 * The stored config format is untouched: the result is still a
 * `{ width, height, bitmap }` RGBA block that the driver centres on
 * the panel. `centeredBounds` trims the transparent margin
 * symmetrically, so an un-touched "fit" crop of a 16:9 image still
 * ships as 64×36 (same payload as before), while an off-centre crop
 * keeps enough transparent margin to land where the user put it.
 */

export const PANEL_W = 64;
export const PANEL_H = 64;

export type CropTransform = {
  /** Panel pixels per source pixel. */
  scale: number;
  /** Panel-space x of the source image's centre. */
  cx: number;
  /** Panel-space y of the source image's centre. */
  cy: number;
};

/** Scale at which the whole source fits inside the panel. */
export function fitScale(srcW: number, srcH: number): number {
  return Math.min(PANEL_W / srcW, PANEL_H / srcH);
}

/** Scale at which the source covers the whole panel. */
export function fillScale(srcW: number, srcH: number): number {
  return Math.max(PANEL_W / srcW, PANEL_H / srcH);
}

/**
 * Zoom range. Down to half of "fit" (a small image centred on black
 * is a legitimate choice), up to whichever is larger of 1:1 source
 * pixels or 4× "fill" — enough to pick a face out of a phone photo,
 * and enough headroom to blow up a tiny sprite.
 */
export function scaleBounds(
  srcW: number,
  srcH: number,
): { min: number; max: number } {
  const fit = fitScale(srcW, srcH);
  const fill = fillScale(srcW, srcH);
  return { min: fit * 0.5, max: Math.max(1, fill * 4) };
}

export function fitTransform(srcW: number, srcH: number): CropTransform {
  return { scale: fitScale(srcW, srcH), cx: PANEL_W / 2, cy: PANEL_H / 2 };
}

export function fillTransform(srcW: number, srcH: number): CropTransform {
  return { scale: fillScale(srcW, srcH), cx: PANEL_W / 2, cy: PANEL_H / 2 };
}

/**
 * Clamp scale into range and keep the image overlapping the panel:
 * at least `MIN_OVERLAP` panel px of it (or all of it, if smaller)
 * stays on screen, so you can't fling the image off into the void.
 */
const MIN_OVERLAP = 8;

export function clampTransform(
  t: CropTransform,
  srcW: number,
  srcH: number,
): CropTransform {
  const { min, max } = scaleBounds(srcW, srcH);
  const scale = Math.min(max, Math.max(min, t.scale));
  const halfW = (srcW * scale) / 2;
  const halfH = (srcH * scale) / 2;
  const mx = Math.min(MIN_OVERLAP, halfW * 2);
  const my = Math.min(MIN_OVERLAP, halfH * 2);
  const cx = Math.min(PANEL_W + halfW - mx, Math.max(-halfW + mx, t.cx));
  const cy = Math.min(PANEL_H + halfH - my, Math.max(-halfH + my, t.cy));
  return { scale, cx, cy };
}

/**
 * Zoom by `ratio` keeping the panel-space point (`px`, `py`) fixed
 * under the cursor / pinch midpoint. Clamped.
 */
export function zoomAbout(
  t: CropTransform,
  ratio: number,
  px: number,
  py: number,
  srcW: number,
  srcH: number,
): CropTransform {
  const { min, max } = scaleBounds(srcW, srcH);
  const scale = Math.min(max, Math.max(min, t.scale * ratio));
  const r = scale / t.scale;
  return clampTransform(
    { scale, cx: px + (t.cx - px) * r, cy: py + (t.cy - py) * r },
    srcW,
    srcH,
  );
}

/**
 * Draw `source` through `t` onto a PANEL_W×PANEL_H context (cleared
 * to transparent first). Minifying uses high-quality smoothing (same
 * as the old fit-to-panel path); magnifying uses nearest-neighbour so
 * zoomed-in pixel art stays crisp instead of smearing.
 */
export function drawCrop(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  t: CropTransform,
): void {
  ctx.clearRect(0, 0, PANEL_W, PANEL_H);
  // Snap the drawn rect's edges to whole panel pixels. The panel has
  // binary alpha, so a half-covered edge row would light at full
  // intensity as a dim fringe line; snapping (≤½px stretch) also makes
  // "fit" land on exactly the old Math.round(src × ratio) dims.
  const w = srcW * t.scale;
  const h = srcH * t.scale;
  const x0 = Math.round(t.cx - w / 2);
  const y0 = Math.round(t.cy - h / 2);
  const x1 = Math.max(x0 + 1, Math.round(t.cx + w / 2));
  const y1 = Math.max(y0 + 1, Math.round(t.cy + h / 2));
  ctx.imageSmoothingEnabled = t.scale < 1;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, x0, y0, x1 - x0, y1 - y0);
}

export function makePanelCanvas(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = PANEL_W;
  canvas.height = PANEL_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return { canvas, ctx };
}

export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Smallest rectangle, centred on the panel, that contains every
 * non-transparent pixel across `frames` (full-panel RGBA buffers).
 * Centred because the driver centres whatever width×height it gets
 * (display_core::frames::image::render) — trimming symmetrically
 * keeps every pixel where the editor put it. Margins are trimmed in
 * equal pairs, so (PANEL - size) is always even and the driver's
 * integer centring is exact. A fully transparent crop keeps the whole
 * panel (renders as nothing, but stays a valid config).
 */
export function centeredBounds(frames: Uint8ClampedArray[]): Bounds {
  let minX = PANEL_W;
  let maxX = -1;
  let minY = PANEL_H;
  let maxY = -1;
  for (const data of frames) {
    for (let y = 0; y < PANEL_H; y++) {
      const row = y * PANEL_W * 4;
      for (let x = 0; x < PANEL_W; x++) {
        if (data[row + x * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: PANEL_W, height: PANEL_H };
  const mx = Math.min(minX, PANEL_W - 1 - maxX);
  const my = Math.min(minY, PANEL_H - 1 - maxY);
  return { x: mx, y: my, width: PANEL_W - 2 * mx, height: PANEL_H - 2 * my };
}

/** Copy `b` out of a full-panel RGBA buffer as a plain number[]. */
export function sliceBounds(data: Uint8ClampedArray, b: Bounds): number[] {
  if (b.x === 0 && b.y === 0 && b.width === PANEL_W && b.height === PANEL_H) {
    return Array.from(data);
  }
  const out = new Array<number>(b.width * b.height * 4);
  let o = 0;
  for (let y = b.y; y < b.y + b.height; y++) {
    const start = (y * PANEL_W + b.x) * 4;
    for (let i = 0; i < b.width * 4; i++) out[o++] = data[start + i];
  }
  return out;
}
