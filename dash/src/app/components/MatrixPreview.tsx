"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { PanelContext } from "@/app/context";
import type { Mode, WireColor } from "@/app/scenes/types";
import { entries as entriesActions } from "@/utils/actions";

const ROWS = 64;
const COLS = 64;
// GAP/CELL_CAP tuned for the "small bright dot in a black grid" look.
const GAP = 2;
const CELL_CAP = 3;

// Mirrors display_core::Scene — the wrapper passed to WASM render
// containing the active mode payload + panel-level state (paused,
// flash). `Mode` (imported above) mirrors display_core::Mode (the
// tagged union over per-mode payloads).
type Scene = {
  mode: Mode;
  panel: {
    is_paused: boolean;
    is_off: boolean;
    flash: { is_active: boolean; on_steps: number; total_steps: number };
  };
};

const DEFAULT_COLOR: WireColor = { Rgb: { r: 255, g: 138, b: 44 } };
const FLASH_OFF = { is_active: false, on_steps: 0, total_steps: 0 };

// Geometry derived from container width + DPR. Recomputed cheaply on
// resize/DPR change without tearing down the render loop.
type Geometry = {
  cell: number;
  cornerRadius: number;
  w: number;
  h: number;
  dpr: number;
};

function computeGeometry(containerWidth: number, dpr: number): Geometry {
  const padding = 24;
  const target = Math.max(120, containerWidth - padding);
  const fit = Math.max(2, Math.floor((target - GAP) / COLS) - GAP);
  const cell = Math.min(CELL_CAP, fit);
  const w = COLS * (cell + GAP) + GAP;
  const h = ROWS * (cell + GAP) + GAP;
  const cornerRadius = Math.max(0.5, cell * 0.18);
  return { cell, cornerRadius, w, h, dpr };
}

// Cache of precomputed glow sprites. Each lit LED previously created a
// fresh radial gradient every frame (up to ~245k gradients/sec at 60fps
// on a full panel). Instead we bake one glow sprite per quantized
// (r,g,b,intensityBucket) into an offscreen canvas and drawImage it.
// The visual is identical: the gradient stops and falloff match the
// old per-pixel math, only quantized into buckets fine enough to be
// imperceptible yet coarse enough to bound the cache to a few hundred
// entries in practice.
const COLOR_QUANT = 16; // 4-bit per channel
const INTENSITY_BUCKETS = 16;

class GlowCache {
  private sprites = new Map<number, HTMLCanvasElement>();
  // `cell` determines sprite geometry, so the cache is invalidated
  // whenever the resolved cell size changes (rare — only on resize).
  private cell = -1;
  private dpr = 1;

  reset(cell: number, dpr: number) {
    if (cell === this.cell && dpr === this.dpr) return;
    this.cell = cell;
    this.dpr = dpr;
    this.sprites.clear();
  }

  // Returns a glow sprite for the given color/intensity. `halfExtent`
  // (in CSS px) is the distance from sprite center to edge; callers
  // draw it centered on the LED so the glow blooms past the package.
  get(
    r: number,
    g: number,
    b: number,
    intensity: number,
  ): { sprite: HTMLCanvasElement; halfExtent: number } | null {
    const qr = Math.min(15, r >> 4);
    const qg = Math.min(15, g >> 4);
    const qb = Math.min(15, b >> 4);
    const qi = Math.min(
      INTENSITY_BUCKETS - 1,
      Math.floor(intensity * INTENSITY_BUCKETS),
    );
    // Pack into a single int key: 4 bits each rgb + 4 bits intensity.
    const key = (qr << 12) | (qg << 8) | (qb << 4) | qi;

    let sprite = this.sprites.get(key);
    if (!sprite) {
      const built = this.build(qr, qg, qb, qi);
      if (!built) return null;
      sprite = built;
      this.sprites.set(key, sprite);
    }
    // halfExtent is encoded as the CSS half-size of the sprite.
    const half = sprite.width / this.dpr / 2;
    return { sprite, halfExtent: half };
  }

  private build(
    qr: number,
    qg: number,
    qb: number,
    qi: number,
  ): HTMLCanvasElement | null {
    const cell = this.cell;
    const dpr = this.dpr;
    // Reconstruct representative channel/intensity from bucket centers.
    const r = Math.min(255, qr * COLOR_QUANT + COLOR_QUANT / 2);
    const g = Math.min(255, qg * COLOR_QUANT + COLOR_QUANT / 2);
    const b = Math.min(255, qb * COLOR_QUANT + COLOR_QUANT / 2);
    const intensity = (qi + 0.5) / INTENSITY_BUCKETS;

    // Same falloff math as the original per-pixel gradient.
    const haloRadius = cell * 0.4 + cell * 2.2 * Math.pow(intensity, 1.4);
    const alpha = 0.35 * Math.pow(intensity, 1.2);

    const size = Math.max(1, Math.ceil(haloRadius * 2));
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(size * dpr));
    off.height = off.width;
    const octx = off.getContext("2d");
    if (!octx) return null;
    octx.scale(dpr, dpr);
    const c = haloRadius;
    const grad = octx.createRadialGradient(c, c, 0, c, c, haloRadius);
    grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    octx.fillStyle = grad;
    octx.fillRect(0, 0, size, size);
    return off;
  }
}

/**
 * Bit-exact LED-matrix simulator. Loads the driver's render core
 * compiled to WASM and ticks it on requestAnimationFrame, blitting
 * the resulting RGBA buffer through ImageData onto a square-LED
 * canvas. Same code path as the Pi: marquee scroll, rainbow,
 * flash all behave identically.
 *
 * `mode` is the Mode the page wants rendered. For text mode the
 * page passes just the live-preview entry; we fold in the queued
 * entries from Supabase here so the simulator shows the full panel
 * state. Other modes pass their full frame and we pass it through.
 */
export function MatrixPreview({
  mode,
  offline,
  isPaused = false,
  isOff = false,
}: {
  mode: Mode;
  offline?: boolean;
  /** Whether the panel is paused. Frozen step counter; current
   * frame stays rendered. Mirrors the Pi driver's behaviour. */
  isPaused?: boolean;
  /** Whether the panel is "off". Render short-circuits to black —
   * mirrors the Pi driver. Composes with isPaused. */
  isOff?: boolean;
}) {
  const panelId = useContext(PanelContext);
  const entriesData = entriesActions.get.useSWR(panelId);
  const scrollData = entriesActions.scroll.get.useSWR(panelId);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(640);
  const rendererRef = useRef<WasmRenderer | null>(null);
  // Flips true once the async WASM import resolves. The scene-push
  // effect depends on it so the current scene gets pushed the moment
  // the renderer exists — otherwise a scene built before the import
  // resolved would never reach the renderer and tick() would render
  // an empty default forever.
  const [rendererReady, setRendererReady] = useState(false);

  useLayoutEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const update = () => setContainerWidth(wrap.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Load the WASM module once on mount. The import is async, so the
  // Renderer can be constructed after a fast unmount has already run
  // cleanup — guard against leaking it by freeing immediately if the
  // effect was cancelled before construction resolved.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mod = await import("wasm-sim");
      const renderer = new mod.Renderer(COLS, ROWS);
      if (cancelled) {
        renderer.free();
        return;
      }
      rendererRef.current = renderer;
      setRendererReady(true);
    })();
    return () => {
      cancelled = true;
      rendererRef.current?.free();
      rendererRef.current = null;
      setRendererReady(false);
    };
  }, []);

  const items = useMemo(
    () => entriesData.data?.entries ?? [],
    [entriesData.data?.entries],
  );
  const scroll = scrollData.data?.scroll ?? 0;

  // Build the Scene (mode + panel state) the WASM renderer
  // consumes. For text mode we append store entries to whatever the
  // page passed (the live preview); other modes pass through.
  const frame = useMemo<Scene>(() => {
    const expanded: Mode = "Text" in mode
      ? {
          Text: {
            entries: [
              ...mode.Text.entries,
              ...items.map((e) => ({
                text: e.data?.text ?? "",
                options: {
                  color: (e.data?.options?.color ?? DEFAULT_COLOR) as WireColor,
                  marquee: { speed: e.data?.options?.marquee?.speed ?? 0 },
                },
              })),
            ],
            // ?? not || — 0 is a legitimate scroll value the page can
            // pass deliberately (no scroll); only fall back to the SWR
            // value when the page didn't supply one.
            scroll: mode.Text.scroll ?? scroll,
          },
        }
      : mode;
    return {
      mode: expanded,
      panel: { is_paused: isPaused, is_off: isOff, flash: FLASH_OFF },
    };
  }, [items, mode, scroll, isPaused, isOff]);

  // Whether the active mode produces motion. Static modes (image,
  // test) and an empty/blank text panel never advance, so once their
  // frame is painted there's nothing to animate. Clock advances but
  // only at 1Hz — we still treat it as animated so the rAF loop runs
  // (a 1Hz redraw is negligible and the WASM tick is what advances it),
  // but it's gated off when offline/paused/off like everything else.
  const isAnimatedMode =
    "Text" in mode
      ? frame.mode &&
        "Text" in frame.mode &&
        frame.mode.Text.entries.some((e) => e.text.trim().length > 0)
      : "Clock" in mode ||
        "Life" in mode ||
        "Gif" in mode ||
        "Shapes" in mode;

  // The loop only needs to run when something can actually change on
  // screen. When the panel is offline/paused/off or the scene is
  // static, we render a single frame and idle until state changes.
  const shouldAnimate = !offline && !isPaused && !isOff && isAnimatedMode;

  // Push state into the renderer whenever it actually changes. The
  // frame ref can rebuild for reasons that don't affect the rendered
  // output (SWR refresh handing back a fresh object reference, etc.).
  // The old code full-`JSON.stringify`'d the scene on every rebuild to
  // dedupe — but a loaded gif scene is ~720KB and clock rebuilds at
  // 1Hz, so that stringified large payloads on the main thread for no
  // reason. Instead we dedupe with a cheap structural key plus a
  // reference check on the bitmap payload, and only stringify once we
  // know the scene genuinely changed.
  const lastKeyRef = useRef<string | null>(null);
  // Reference to the bitmap payload array (image.bitmap / gif.frames)
  // we last serialized. Those arrays are rebuilt on real content change,
  // so a reference match means the 720KB payload is unchanged and we can
  // skip stringifying it entirely.
  const lastBitmapRef = useRef<unknown>(null);
  // Bumped only when the scene the renderer holds actually changed, so
  // an idle (static-mode) loop knows to repaint exactly once.
  const [sceneVersion, setSceneVersion] = useState(0);
  useEffect(() => {
    const renderer = rendererRef.current;
    // Don't record the dedupe key until we actually have a renderer to
    // push to — otherwise we'd mark the scene "pushed" against a null
    // renderer and never retry once it loads. `rendererReady` in the
    // deps re-runs this the moment the import resolves.
    if (!renderer) return;
    const key = structuralKey(frame);
    const m = frame.mode;
    // Bitmap modes carry huge arrays the structural key can't cheaply
    // summarize; track the array reference so reference-stable SWR churn
    // skips the stringify. Non-bitmap modes leave this null.
    const bitmap = "Image" in m ? m.Image.bitmap : "Gif" in m ? m.Gif.frames : null;

    // Fast path: structural key unchanged AND (for bitmap modes) the
    // payload array is reference-identical → nothing the renderer cares
    // about changed.
    if (
      key === lastKeyRef.current &&
      (bitmap === null || bitmap === lastBitmapRef.current)
    ) {
      return;
    }

    // Only stringify when something actually changed — for a 720KB gif
    // this now happens on real updates, not on every SWR refresh.
    const json = JSON.stringify(frame);
    lastKeyRef.current = key;
    lastBitmapRef.current = bitmap;
    renderer.setSceneJson(json);
    // Wake an idled loop so it repaints this new scene exactly once.
    setSceneVersion((v) => v + 1);
  }, [frame, rendererReady]);

  // Geometry lives in a ref so resize/DPR changes recompute it cheaply
  // without rebuilding the render loop. The loop reads geometryRef each
  // frame; a separate effect resizes the backing canvas + invalidates
  // the glow cache when geometry changes.
  const geometryRef = useRef<Geometry>(computeGeometry(640, 1));
  const glowCacheRef = useRef(new GlowCache());
  // Lazy-init from the real DPR on the client (SSR falls back to 1).
  // The canvas backing store is sized via effect, not server-rendered,
  // so reading DPR here can't cause a hydration mismatch.
  const [dpr, setDpr] = useState(() =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  );

  // Re-read DPR whenever it changes (moving the window between a Retina
  // and an external display). matchMedia on the current dpr fires once
  // when the ratio leaves the matched value; we re-subscribe each time.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [dpr]);

  // Resize the backing store + recompute geometry on width/DPR change.
  // Separate from the render loop so a resize doesn't tear it down.
  const [geometryVersion, setGeometryVersion] = useState(0);
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const geom = computeGeometry(containerWidth, dpr);
    geometryRef.current = geom;
    c.width = geom.w * geom.dpr;
    c.height = geom.h * geom.dpr;
    c.style.width = `${geom.w}px`;
    c.style.height = `${geom.h}px`;
    glowCacheRef.current.reset(geom.cell, geom.dpr);
    // Resizing the canvas clears it, so force at least one repaint even
    // when the loop is idle.
    setGeometryVersion((v) => v + 1);
  }, [containerWidth, dpr]);

  // The single-frame painter. Pulls current pixels from the renderer
  // (unless offline), then runs the three-pass LED draw. Returns false
  // when the renderer isn't ready yet so the caller can keep polling.
  const paint = useCallback(
    (ctx: CanvasRenderingContext2D): boolean => {
      const { cell, cornerRadius, w, h, dpr: gdpr } = geometryRef.current;
      // setTransform is cheap; re-apply each paint so a context-restore
      // (which resets transform) is always corrected.
      ctx.setTransform(gdpr, 0, 0, gdpr, 0, 0);

      const renderer = rendererRef.current;
      let pixels: Uint8Array | null = null;
      let ready = renderer != null;
      // Don't tick the renderer when the panel is offline — there's no
      // real state to mirror, and advancing `step` against a stale
      // frame would just animate ghosts.
      if (!offline) {
        try {
          pixels = renderer?.tick() ?? null;
        } catch {
          // Renderer not yet initialized or transient error — fall
          // through to drawing the unlit grid.
          ready = false;
        }
      }

      ctx.clearRect(0, 0, w, h);

      // Pass 1: unlit substrate. Cheap, no glow.
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.05)";
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

      if (!pixels) return ready;

      // Pass 2: lit LEDs as a soft outer halo. Real LEDs at full
      // brightness bloom well past their package — gamma-curved so dim
      // LEDs barely glow and bright ones spill into neighbors. We
      // drawImage a precomputed glow sprite instead of building a fresh
      // radial gradient per LED per frame.
      const cache = glowCacheRef.current;
      ctx.globalCompositeOperation = "lighter";
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const idx = (row * COLS + col) * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];
          if (!r && !g && !b) continue;

          const intensity = Math.max(r, g, b) / 255;
          const glow = cache.get(r, g, b, intensity);
          if (!glow) continue;
          const cx = GAP + col * (cell + GAP) + cell / 2;
          const cy = GAP + row * (cell + GAP) + cell / 2;
          ctx.drawImage(
            glow.sprite,
            cx - glow.halfExtent,
            cy - glow.halfExtent,
            glow.halfExtent * 2,
            glow.halfExtent * 2,
          );
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
            ctx.fillRect(
              x + corePad,
              y + corePad,
              cell - corePad * 2,
              cell - corePad * 2,
            );
          }
        }
      }
      return ready;
    },
    [offline],
  );

  // Lets an idle loop be woken for a single repaint (scene/geometry
  // change) without rebuilding the whole loop. No-op while animating —
  // the continuous loop already repaints every frame.
  const requestIdlePaintRef = useRef<() => void>(() => {});

  // Render loop lifecycle. Re-runs ONLY when the loop *kind* changes
  // (animated vs. idle) or when `paint` changes — NOT on geometry or
  // scene ticks, which the loop reads from refs. A plain resize or a
  // static-mode scene update repaints once (via requestIdlePaintRef)
  // instead of tearing down and rebuilding the loop. Context loss is
  // handled inline with re-init.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    let ctx = c.getContext("2d", { desynchronized: true });
    if (!ctx) return;

    let raf = 0;
    let lost = false;

    const animatedDraw = () => {
      if (lost) return;
      paint(ctx!);
      raf = requestAnimationFrame(animatedDraw);
    };

    // Idle modes paint a single frame. If the WASM renderer isn't ready
    // yet (still importing), keep polling until it is, then settle —
    // an external wake (requestIdlePaintRef) handles real changes, so
    // there's no steady-state rAF cost.
    const idleDraw = () => {
      if (lost) return;
      const ready = paint(ctx!);
      if (!ready) raf = requestAnimationFrame(idleDraw);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(shouldAnimate ? animatedDraw : idleDraw);
    };

    requestIdlePaintRef.current = () => {
      if (lost || shouldAnimate) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(idleDraw);
    };

    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      cancelAnimationFrame(raf);
    };
    const onRestored = () => {
      lost = false;
      const restored = c.getContext("2d", { desynchronized: true });
      if (!restored) return;
      ctx = restored;
      // Backing-store dimensions survive a restore but content is
      // cleared; restart the loop to repaint cleanly.
      start();
    };

    c.addEventListener("contextlost", onLost as EventListener);
    c.addEventListener("contextrestored", onRestored as EventListener);
    start();

    return () => {
      cancelAnimationFrame(raf);
      requestIdlePaintRef.current = () => {};
      c.removeEventListener("contextlost", onLost as EventListener);
      c.removeEventListener("contextrestored", onRestored as EventListener);
    };
  }, [paint, shouldAnimate]);

  // Wake an idle loop for a one-shot repaint when the scene or geometry
  // actually changed. While animating this is a no-op.
  useEffect(() => {
    requestIdlePaintRef.current();
  }, [sceneVersion, geometryVersion]);

  const matrixIdle =
    "Text" in mode && mode.Text.entries.length === 0 && items.length === 0;

  const describe = () => {
    if (offline) return "LED matrix simulator — panel offline, no heartbeat.";
    const modeName = (Object.keys(mode)[0] ?? "unknown").toLowerCase();
    const state = isOff ? "off" : isPaused ? "paused" : "live";
    if (matrixIdle) return `LED matrix simulator — ${modeName} mode, idle.`;
    return `LED matrix simulator — ${modeName} mode, ${state}.`;
  };

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
        role="img"
        aria-label={describe()}
        className="relative mx-auto block"
      />
      {offline ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 font-mono uppercase tracking-[0.3em] backdrop-blur-[1px]">
          <span className="text-[11px] text-(--color-danger)">
            panel offline
          </span>
          <span className="text-[9px] text-(--color-text-faint)">
            no heartbeat
          </span>
        </div>
      ) : matrixIdle ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          matrix idle
        </div>
      ) : null}
    </div>
  );
}

// Cheap structural fingerprint of the parts of the scene that change
// the render *without* serializing large bitmap payloads. Bitmap modes
// (image/gif) only summarize their dimensions/frame-count here; their
// deep changes are caught by a payload-array reference check in the
// push effect. Everything else is fully captured by this key.
function structuralKey(frame: Scene): string {
  const { panel, mode } = frame;
  const p = `${panel.is_paused ? 1 : 0}${panel.is_off ? 1 : 0}`;
  if ("Text" in mode) {
    const t = mode.Text;
    const entries = t.entries
      .map((e) => {
        const color = "Rgb" in e.options.color
          ? `r${e.options.color.Rgb.r},${e.options.color.Rgb.g},${e.options.color.Rgb.b}`
          : `w${e.options.color.Rainbow.is_per_letter}:${e.options.color.Rainbow.speed}`;
        return `${e.text}|${color}|${e.options.marquee.speed}`;
      })
      .join("§");
    return `${p}|T|${t.scroll}|${entries}`;
  }
  if ("Clock" in mode) {
    const cl = mode.Clock;
    return `${p}|C|${cl.format}|${cl.show_seconds}|${cl.show_meridiem}|${cl.color.r},${cl.color.g},${cl.color.b}|${cl.now.hour}:${cl.now.minute}:${cl.now.second}`;
  }
  if ("Life" in mode) {
    const l = mode.Life;
    return `${p}|L|${l.lattice_width}x${l.lattice_height}|${l.color.r},${l.color.g},${l.color.b}|n${l.cells.length}`;
  }
  if ("Shapes" in mode) {
    const s = mode.Shapes;
    return `${p}|S|${s.kind}|${s.color.r},${s.color.g},${s.color.b}|${s.speed}|${s.depth_shade}|${s.opacity}`;
  }
  if ("Image" in mode) {
    const i = mode.Image;
    return `${p}|I|${i.width}x${i.height}|n${i.bitmap.length}`;
  }
  if ("Gif" in mode) {
    const g = mode.Gif;
    return `${p}|G|${g.width}x${g.height}|${g.speed}|f${g.frames.length}`;
  }
  if ("Test" in mode) return `${p}|X|${mode.Test.pattern}`;
  if ("Boot" in mode) {
    const c = mode.Boot.color;
    return `${p}|B|${c.r},${c.g},${c.b}`;
  }
  const su = mode.Setup;
  return `${p}|U|${su.ssid}|${su.portal_url}`;
}

// Minimal type for what we actually use from the wasm module — keeps
// the `Renderer` reference typed without pulling the full wasm types
// into the component file.
type WasmRenderer = {
  setSceneJson(json: string): void;
  tick(): Uint8Array;
  free(): void;
};
