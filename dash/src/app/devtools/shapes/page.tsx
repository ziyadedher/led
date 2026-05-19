"use client";

import { useEffect, useRef, useState } from "react";

type Stats = {
  lit: number;
  total: number;
  maxV: number;
  hist: number[];
};

type ShapeKind =
  | "Cube"
  | "Tetrahedron"
  | "Octahedron"
  | "Icosahedron"
  | "Torus"
  | "Hypercube";

const SHAPES: ShapeKind[] = [
  "Cube",
  "Tetrahedron",
  "Octahedron",
  "Icosahedron",
  "Torus",
  "Hypercube",
];

const STEPS = [0, 15, 30, 45, 60, 90, 120, 180];
const UPSCALE = 6;
const PANEL = 64;

function statsOf(buf: Uint8Array): Stats {
  let lit = 0;
  let maxV = 0;
  const hist = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < buf.length; i += 4) {
    const v = Math.max(buf[i], buf[i + 1], buf[i + 2]);
    if (v > 0) lit++;
    if (v > maxV) maxV = v;
    hist[Math.min(7, Math.floor(v / 32))]++;
  }
  return { lit, total: buf.length / 4, maxV, hist };
}

export default function DebugShapesPage() {
  const [kind, setKind] = useState<ShapeKind>("Cube");
  const [opacity, setOpacity] = useState(1);
  const [depthShade, setDepthShade] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [hex, setHex] = useState("#ff0000");
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const liveRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<Record<number, Stats>>({});
  const [hSteps, setHSteps] = useState(STEPS);

  // Animation step for the live canvas.
  const [liveStep, setLiveStep] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let liveRenderer: WasmRenderer | null = null;
    (async () => {
      const mod = await import("wasm-sim");
      if (cancelled) return;
      const r = new mod.Renderer(PANEL, PANEL);
      liveRenderer = r;

      // Expose for console probing.
      (window as unknown as {
        __shapeDbg: {
          render: (kind: ShapeKind, step: number, cfg?: Partial<ShapeCfg>) => Uint8Array;
          statsOf: typeof statsOf;
        };
      }).__shapeDbg = {
        render: (k, step, cfg = {}) => {
          const scene = {
            mode: {
              Shapes: {
                kind: k,
                color: parseHex(cfg.hex ?? hex),
                speed: cfg.speed ?? speed,
                opacity: cfg.opacity ?? opacity,
                depth_shade: cfg.depthShade ?? depthShade,
              },
            },
            panel: {
              is_paused: false,
              is_off: false,
              flash: { is_active: false, on_steps: 0, total_steps: 0 },
            },
          };
          // Reset by recreating; ticking is monotonic so we need fresh renderer
          // for step=0.
          const r2 = new mod.Renderer(PANEL, PANEL);
          r2.setSceneJson(JSON.stringify(scene));
          let buf: Uint8Array = new Uint8Array(0);
          for (let i = 0; i <= step; i++) buf = r2.tick();
          r2.free();
          return buf;
        },
        statsOf,
      };

      // Snapshot grid at fixed steps.
      const newStats: Record<number, Stats> = {};
      for (const s of hSteps) {
        const scene = {
          mode: {
            Shapes: {
              kind,
              color: parseHex(hex),
              speed,
              opacity,
              depth_shade: depthShade,
            },
          },
          panel: {
            is_paused: false,
            is_off: false,
            flash: { is_active: false, on_steps: 0, total_steps: 0 },
          },
        };
        const r2 = new mod.Renderer(PANEL, PANEL);
        r2.setSceneJson(JSON.stringify(scene));
        let buf: Uint8Array = new Uint8Array(0);
        for (let i = 0; i <= s; i++) buf = r2.tick();
        r2.free();
        newStats[s] = statsOf(buf);
        const c = canvasRefs.current[s];
        if (c) blit(c, buf);
      }
      setStats(newStats);

      // Live canvas: keep ticking.
      r.setSceneJson(
        JSON.stringify({
          mode: {
            Shapes: {
              kind,
              color: parseHex(hex),
              speed,
              opacity,
              depth_shade: depthShade,
            },
          },
          panel: {
            is_paused: false,
            is_off: false,
            flash: { is_active: false, on_steps: 0, total_steps: 0 },
          },
        }),
      );
      let n = 0;
      const tick = () => {
        if (cancelled) return;
        const buf = r.tick();
        n++;
        const c = liveRef.current;
        if (c) blit(c, buf);
        setLiveStep(n);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      // Free the live renderer eagerly so StrictMode's double-mount
      // can't leave a stale WASM renderer ticking against the canvas.
      liveRenderer?.free();
      liveRenderer = null;
    };
  }, [kind, opacity, depthShade, speed, hex, hSteps]);

  return (
    <main className="min-h-screen bg-black p-4 font-mono text-xs text-white">
      <h1 className="mb-2 text-lg">shapes renderer debug</h1>
      <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-6">
        <label className="flex flex-col">
          shape
          <select
            className="bg-zinc-800 p-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as ShapeKind)}
          >
            {SHAPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          opacity ({opacity.toFixed(2)})
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
          />
        </label>
        <label className="flex flex-col">
          speed ({speed.toFixed(2)})
          <input
            type="range"
            min={0.05}
            max={6}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
          />
        </label>
        <label className="flex flex-col">
          color
          <input
            type="color"
            value={hex}
            onChange={(e) => setHex(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={depthShade}
            onChange={(e) => setDepthShade(e.target.checked)}
          />
          depth_shade
        </label>
        <label className="flex flex-col">
          step grid (comma-sep)
          <input
            className="bg-zinc-800 p-1"
            defaultValue={STEPS.join(",")}
            onBlur={(e) => {
              const v = e.target.value
                .split(",")
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => Number.isFinite(n));
              if (v.length) setHSteps(v);
            }}
          />
        </label>
      </div>

      <section className="mb-4">
        <h2 className="mb-1">live (rAF, step={liveStep})</h2>
        <canvas
          ref={liveRef}
          className="border border-zinc-700"
          style={{ imageRendering: "pixelated", width: PANEL * UPSCALE, height: PANEL * UPSCALE }}
          width={PANEL}
          height={PANEL}
        />
      </section>

      <section>
        <h2 className="mb-1">step grid (raw RGBA, no bloom)</h2>
        <div className="flex flex-wrap gap-3">
          {hSteps.map((s) => (
            <div key={s} className="flex flex-col items-center">
              <canvas
                ref={(el) => {
                  canvasRefs.current[s] = el;
                }}
                className="border border-zinc-700"
                style={{
                  imageRendering: "pixelated",
                  width: PANEL * UPSCALE,
                  height: PANEL * UPSCALE,
                }}
                width={PANEL}
                height={PANEL}
              />
              <div className="mt-1 text-[10px] tabular-nums">
                step={s} · lit={stats[s]?.lit ?? "—"} · max={stats[s]?.maxV ?? "—"}
              </div>
              <div className="text-[9px] text-zinc-400">
                hist {stats[s]?.hist?.join("/")}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

type ShapeCfg = {
  kind: ShapeKind;
  opacity: number;
  depthShade: boolean;
  speed: number;
  hex: string;
};

type WasmRenderer = {
  setSceneJson(json: string): void;
  tick(): Uint8Array;
  free(): void;
};

function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function blit(canvas: HTMLCanvasElement, buf: Uint8Array) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(PANEL, PANEL);
  img.data.set(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength));
  ctx.putImageData(img, 0, 0);
}
