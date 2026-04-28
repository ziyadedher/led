"use client";

import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_LIFE_CONFIG,
  type LifeModeConfig,
  type LifeModeFrame,
} from "./types";

import { panels } from "@/utils/actions";

const W = 64;
const H = 64;
const STEP_INTERVAL_FRAMES = 8;
const RESEED_GENERATIONS = 1500;

export function parseLifeConfig(raw: unknown): LifeModeConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_LIFE_CONFIG;
  const obj = raw as Record<string, unknown>;
  const colorRaw =
    obj.color && typeof obj.color === "object"
      ? (obj.color as Record<string, unknown>)
      : null;
  if (!colorRaw) return DEFAULT_LIFE_CONFIG;
  return {
    color: {
      r: clamp255(colorRaw.r),
      g: clamp255(colorRaw.g),
      b: clamp255(colorRaw.b),
    },
  };
}

function clamp255(n: unknown): number {
  const v = typeof n === "number" ? n : 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Drive the in-browser preview of Life mode. Cells live in React
 * state so the rendered LifeModeFrame updates reactively (React 19
 * disallows reading ref.current during render). Tick counters stay
 * in refs since they don't drive output.
 *
 * Both simulators (driver and dash) use the same step interval and
 * reseed thresholds, so a fresh seed evolves through visually
 * comparable patterns.
 */
export function useLifeFrame(config: LifeModeConfig): LifeModeFrame {
  const [cells, setCells] = useState<Uint8Array>(() => seed());
  const framesRef = useRef(0);
  const generationsRef = useRef(0);
  const recentPopRef = useRef<number[]>([0, 0, 0, 0]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      framesRef.current += 1;
      if (framesRef.current >= STEP_INTERVAL_FRAMES) {
        framesRef.current = 0;
        setCells((prev) => {
          const next = step(prev);
          generationsRef.current += 1;
          const pop = population(next);
          recentPopRef.current = [...recentPopRef.current.slice(1), pop];
          const stalled =
            recentPopRef.current[0] !== 0 &&
            recentPopRef.current.every((p) => p === pop);
          if (
            stalled ||
            generationsRef.current >= RESEED_GENERATIONS ||
            pop < 5
          ) {
            generationsRef.current = 0;
            recentPopRef.current = [0, 0, 0, 0];
            return seed();
          }
          return next;
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return {
    color: config.color,
    lattice_width: W,
    lattice_height: H,
    cells: Array.from(cells),
  };
}

function seed(): Uint8Array {
  const cells = new Uint8Array(W * H);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = Math.random() < 0.28 ? 1 : 0;
  }
  return cells;
}

function population(cells: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) n += cells[i];
  return n;
}

function step(cells: Uint8Array): Uint8Array {
  const next = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          n += cells[ny * W + nx];
        }
      }
      const alive = cells[y * W + x] !== 0;
      const nextAlive = alive ? n === 2 || n === 3 : n === 3;
      next[y * W + x] = nextAlive ? 1 : 0;
    }
  }
  return next;
}

/** Composer for life mode — just a color picker for the live cells. */
export function LifeComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: LifeModeConfig;
}) {
  const configKey = JSON.stringify(config);
  const [snapshotKey, setSnapshotKey] = useState(configKey);
  const [local, setLocal] = useState<LifeModeConfig>(config);
  if (snapshotKey !== configKey) {
    setSnapshotKey(configKey);
    setLocal(config);
  }

  const persist = (next: LifeModeConfig) => {
    setLocal(next);
    void panels.setMode.call(panelId, "life", next);
  };

  return (
    <section
      className="relative border border-(--color-border) bg-(--color-surface)/70 backdrop-blur-sm"
      aria-label="Life configuration"
    >
      <header className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-2)/40 px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          :: life
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          conway · ambient
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
          live cells reseed automatically when the simulation stalls
          or goes extinct.
        </p>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
            :: hex
          </span>
          <input
            type="text"
            value={rgbToHex(local.color)}
            onChange={(e) => {
              const next = hexToRgb(e.target.value);
              if (next) persist({ color: next });
            }}
            spellCheck={false}
            className="w-32 border-0 border-b border-(--color-border-strong) bg-transparent p-0 pb-1 font-mono text-base uppercase tracking-wider text-(--color-text) focus:border-(--color-accent) focus:outline-none focus:ring-0"
            placeholder="#RRGGBB"
            maxLength={7}
          />
          <span
            className="inline-block h-5 w-5 border border-(--color-border-strong)"
            style={{
              backgroundColor: rgbToHex(local.color),
              boxShadow: `0 0 12px -2px ${rgbToHex(local.color)}`,
            }}
            aria-hidden
          />
        </div>
      </div>
    </section>
  );
}

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) =>
  `#${[r, g, b]
    .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;

function hexToRgb(hex: string) {
  const cleaned = hex.replace(/^#/, "");
  const value = cleaned.length === 3 ? cleaned.replace(/./g, "$&$&") : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
