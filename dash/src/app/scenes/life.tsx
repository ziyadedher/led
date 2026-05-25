"use client";

import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_LIFE_CONFIG,
  defaultLifeConfig,
  type LifeSceneConfig,
  type LifeScene,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { SegmentedToggle } from "@/app/components/SegmentedToggle";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

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

export function parseLifeConfig(raw: unknown): LifeSceneConfig {
  if (!raw || typeof raw !== "object") return defaultLifeConfig();
  const obj = raw as Record<string, unknown>;
  const color = parseRgb(obj.color, DEFAULT_LIFE_CONFIG.color);
  const stepRaw =
    typeof obj.step_interval_frames === "number" ? obj.step_interval_frames : 0;
  const step =
    stepRaw >= 1 && stepRaw <= 120
      ? Math.round(stepRaw)
      : DEFAULT_LIFE_CONFIG.step_interval_frames;
  return { color, step_interval_frames: step };
}

/**
 * Drive the in-browser preview of Life mode. Cells live in React
 * state so the rendered LifeScene updates reactively (React 19
 * disallows reading ref.current during render). Tick counters stay
 * in refs since they don't drive output.
 *
 * Both simulators (driver and dash) honor `step_interval_frames`
 * from config so a fresh seed evolves through visually comparable
 * patterns at matching wall-clock speed.
 */
export function useLifeScene(
  config: LifeSceneConfig,
  enabled = true,
): LifeScene {
  const [cells, setCells] = useState<Uint8Array>(() => seed());
  const framesRef = useRef(0);
  const generationsRef = useRef(0);
  const recentPopRef = useRef<number[]>([0, 0, 0, 0]);
  // Read step_interval_frames via ref so the loop closure picks up
  // changes without re-arming requestAnimationFrame. Synced in an
  // effect — writing a ref during render is a React anti-pattern
  // (and a lint error): the value isn't needed until the next frame.
  const intervalRef = useRef(Math.max(1, config.step_interval_frames));
  useEffect(() => {
    intervalRef.current = Math.max(1, config.step_interval_frames);
  }, [config.step_interval_frames]);

  // page.tsx calls this hook unconditionally (so switching to life is
  // instant), so gate the simulation on `enabled` — otherwise a 64×64
  // Conway board would tick forever on every page view. Also suspend
  // while the tab is hidden.
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const tick = () => {
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
    };
    const loop = () => {
      if (!document.hidden) tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

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

/** Composer for life mode — speed preset + color for the live cells. */
export function LifeComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: LifeSceneConfig;
}) {
  const [draft, update] = useComposerConfig<LifeSceneConfig>(
    panelId,
    "life",
    config,
  );

  // Map current step interval to the closest preset; if it doesn't
  // match exactly, the closest one still highlights for context.
  const activePreset =
    SPEED_PRESETS.find((p) => p.frames === draft.step_interval_frames)?.id ??
    SPEED_PRESETS.reduce((best, p) =>
      Math.abs(p.frames - draft.step_interval_frames) <
      Math.abs(best.frames - draft.step_interval_frames)
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
          <SegmentedToggle
            ariaLabel="Simulation speed"
            options={SPEED_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
            value={activePreset}
            onChange={(id) => {
              const preset = SPEED_PRESETS.find((p) => p.id === id);
              if (preset)
                update({ ...draft, step_interval_frames: preset.frames });
            }}
          />
        </div>
        <SolidColorPicker
          value={draft.color}
          onChange={(color) => update({ ...draft, color })}
        />
      </div>
    </ComposerShell>
  );
}

