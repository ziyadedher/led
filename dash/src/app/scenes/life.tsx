"use client";

import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_LIFE_CONFIG,
  type LifeModeConfig,
  type LifeModeFrame,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { panels } from "@/utils/actions";

const W = 64;
const H = 64;
const RESEED_GENERATIONS = 1500;

/** Speed presets exposed in the composer UI. Values are render
 * frames between lattice ticks — lower = faster. */
const SPEED_PRESETS: { id: string; label: string; frames: number }[] = [
  { id: "slow",    label: "slow",    frames: 30 },
  { id: "medium",  label: "med",     frames: 8  },
  { id: "fast",    label: "fast",    frames: 3  },
  { id: "blazing", label: "blazing", frames: 1  },
];

export function parseLifeConfig(raw: unknown): LifeModeConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_LIFE_CONFIG;
  const obj = raw as Record<string, unknown>;
  const colorRaw =
    obj.color && typeof obj.color === "object"
      ? (obj.color as Record<string, unknown>)
      : null;
  const color = colorRaw
    ? {
        r: clamp255(colorRaw.r),
        g: clamp255(colorRaw.g),
        b: clamp255(colorRaw.b),
      }
    : DEFAULT_LIFE_CONFIG.color;
  const stepRaw =
    typeof obj.step_interval_frames === "number" ? obj.step_interval_frames : 0;
  const step =
    stepRaw >= 1 && stepRaw <= 120
      ? Math.round(stepRaw)
      : DEFAULT_LIFE_CONFIG.step_interval_frames;
  return { color, step_interval_frames: step };
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
 * Both simulators (driver and dash) honor `step_interval_frames`
 * from config so a fresh seed evolves through visually comparable
 * patterns at matching wall-clock speed.
 */
export function useLifeFrame(config: LifeModeConfig): LifeModeFrame {
  const [cells, setCells] = useState<Uint8Array>(() => seed());
  const framesRef = useRef(0);
  const generationsRef = useRef(0);
  const recentPopRef = useRef<number[]>([0, 0, 0, 0]);
  // Read step_interval_frames via ref so the loop closure picks up
  // changes without re-arming requestAnimationFrame.
  const intervalRef = useRef(config.step_interval_frames);
  intervalRef.current = Math.max(1, config.step_interval_frames);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      framesRef.current += 1;
      if (framesRef.current >= intervalRef.current) {
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

  // Map current step interval to the closest preset; if it doesn't
  // match exactly, the closest one still highlights for context.
  const activePreset =
    SPEED_PRESETS.find((p) => p.frames === local.step_interval_frames)?.id ??
    SPEED_PRESETS.reduce((best, p) =>
      Math.abs(p.frames - local.step_interval_frames) <
      Math.abs(best.frames - local.step_interval_frames)
        ? p
        : best,
    ).id;

  return (
    <ComposerShell title="life" status="conway · ambient" ariaLabel="Life configuration">
      <div className="space-y-5 px-4 py-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
          live cells reseed automatically when the simulation stalls
          or goes extinct.
        </p>
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
            :: speed
          </span>
          <div className="flex items-center gap-px border border-(--color-border)">
            {SPEED_PRESETS.map((p) => {
              const active = p.id === activePreset;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => persist({ ...local, step_interval_frames: p.frames })}
                  className={[
                    "px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] transition-colors",
                    active
                      ? "bg-(--color-accent) text-black"
                      : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
                  ].join(" ")}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
        <SolidColorPicker
          value={local.color}
          onChange={(next) => persist({ ...local, color: next })}
        />
      </div>
    </ComposerShell>
  );
}

