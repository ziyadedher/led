"use client";

import { Switch } from "@headlessui/react";

import { SolidColorPicker } from "@/app/components/SolidColorPicker";

export type ColorState =
  | {
      mode: "rgb";
      rgb: { r: number; g: number; b: number };
    }
  | {
      mode: "rainbow";
      perLetter: boolean;
      speed: number;
    };

export function ColorPicker({
  value,
  onChange,
}: {
  value: ColorState;
  onChange: (c: ColorState) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          {"// color"}
        </span>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          <span className={value.mode === "rgb" ? "text-(--color-text)" : ""}>
            rgb
          </span>
          <Switch
            checked={value.mode === "rainbow"}
            onChange={(on) => {
              if (on) {
                onChange({ mode: "rainbow", perLetter: false, speed: 16 });
              } else {
                onChange({ mode: "rgb", rgb: { r: 255, g: 138, b: 44 } });
              }
            }}
            className={[
              "relative inline-flex h-4 w-7 items-center rounded-sm border transition",
              value.mode === "rainbow"
                ? "border-(--color-accent) bg-(--color-accent)/15"
                : "border-(--color-border-strong) bg-(--color-surface-2)",
            ].join(" ")}
          >
            <span className="sr-only">Rainbow mode</span>
            <span
              className={[
                "inline-block h-2.5 w-2.5 rounded-[1px] transition-transform",
                value.mode === "rainbow"
                  ? "translate-x-3.5 bg-(--color-accent) shadow-[0_0_6px_var(--color-accent)]"
                  : "translate-x-0.5 bg-(--color-text-dim)",
              ].join(" ")}
            />
          </Switch>
          <span
            className={value.mode === "rainbow" ? "text-(--color-accent)" : ""}
          >
            rainbow
          </span>
        </div>
      </div>

      {value.mode === "rgb" ? (
        <SolidColorPicker
          value={value.rgb}
          onChange={(rgb) => onChange({ mode: "rgb", rgb })}
        />
      ) : (
        <div className="space-y-3">
          <div
            aria-hidden
            className="h-3 w-full"
            style={{
              background:
                "linear-gradient(90deg, #ff4d6d, #ff8a2c, #ffe066, #a6e22e, #4de0e0, #4da3ff, #a04dff, #ff4d6d)",
            }}
          />
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
              slow
            </span>
            <input
              type="range"
              min={1}
              max={50}
              value={value.speed}
              onChange={(e) =>
                onChange({ ...value, speed: Number(e.target.value) })
              }
              className="fader flex-1"
              style={
                {
                  ["--fader-pos" as string]: `${(value.speed / 50) * 100}%`,
                } as React.CSSProperties
              }
              aria-label="Rainbow speed"
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
              fast
            </span>
            <span className="w-8 text-right font-mono text-[10px] tabular-nums text-(--color-text)">
              {String(value.speed).padStart(2, "0")}
            </span>
          </div>
          <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={value.perLetter}
              onChange={(e) =>
                onChange({ ...value, perLetter: e.target.checked })
              }
              className="h-3 w-3 rounded-[1px] border-(--color-border-strong) bg-(--color-bg) text-(--color-accent) focus:ring-0 focus:ring-offset-0"
            />
            per-letter phase
          </label>
        </div>
      )}
    </div>
  );
}
