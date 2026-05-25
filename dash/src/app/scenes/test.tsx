"use client";

import {
  DEFAULT_TEST_CONFIG,
  defaultTestConfig,
  oneOf,
  TEST_PATTERNS,
  type TestSceneConfig,
  type TestPatternId,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { useComposerConfig } from "@/utils/useComposerConfig";

const PATTERNS: { id: TestPatternId; label: string; blurb: string }[] = [
  { id: "ColorBars",    label: "color bars",    blurb: "RGB primaries + corner pixels for geometry" },
  { id: "Gradient",     label: "gradient",      blurb: "horizontal R/G/B brightness ramps" },
  { id: "Checkerboard", label: "checkerboard",  blurb: "1×1 checker — surfaces moiré + row-driver shadows" },
];

export function parseTestConfig(raw: unknown): TestSceneConfig {
  if (!raw || typeof raw !== "object") return defaultTestConfig();
  const obj = raw as Record<string, unknown>;
  return {
    pattern: oneOf(obj.pattern, TEST_PATTERNS, DEFAULT_TEST_CONFIG.pattern),
  };
}

export function TestComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: TestSceneConfig;
}) {
  const [draft, update] = useComposerConfig<TestSceneConfig>(
    panelId,
    "test",
    config,
  );

  return (
    <ComposerShell title="test" status="diagnostic patterns" ariaLabel="Test pattern configuration">
      <div className="space-y-3 px-4 py-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
          static patterns for diagnosing dead pixels, geometry,
          PWM linearity, moiré.
        </p>
        <div role="radiogroup" aria-label="Test pattern" className="space-y-1">
          {PATTERNS.map((p) => {
            const active = p.id === draft.pattern;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => update({ pattern: p.id })}
                className={[
                  "flex w-full items-baseline justify-between gap-3 border px-3 py-2 text-left transition",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent)",
                  active
                    ? "border-(--color-accent) bg-(--color-accent)/10"
                    : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-surface-2)",
                ].join(" ")}
              >
                <span
                  className={[
                    "font-mono text-[11px] uppercase tracking-[0.25em]",
                    active ? "text-(--color-accent)" : "text-(--color-text)",
                  ].join(" ")}
                >
                  {p.label}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-text-faint)">
                  {p.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </ComposerShell>
  );
}
