"use client";

import { Switch } from "@headlessui/react";
import { useState } from "react";

const PRESET_COLORS = [
  { hex: "#FF8A2C", label: "amber" },
  { hex: "#FF4D6D", label: "rose" },
  { hex: "#FFE066", label: "sun" },
  { hex: "#A6E22E", label: "lime" },
  { hex: "#4DE0E0", label: "cyan" },
  { hex: "#4DA3FF", label: "azure" },
  { hex: "#A04DFF", label: "violet" },
  { hex: "#FFFFFF", label: "white" },
];

import { hexToRgb, rgbToHex } from "@/utils/color";

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
  const [hexDraft, setHexDraft] = useState(() =>
    value.mode === "rgb" ? rgbToHex(value.rgb) : "#FF8A2C",
  );
  const [prevRgb, setPrevRgb] = useState(
    value.mode === "rgb" ? value.rgb : null,
  );
  if (
    value.mode === "rgb" &&
    (!prevRgb ||
      prevRgb.r !== value.rgb.r ||
      prevRgb.g !== value.rgb.g ||
      prevRgb.b !== value.rgb.b)
  ) {
    setPrevRgb(value.rgb);
    setHexDraft(rgbToHex(value.rgb));
  }

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
        <div className="space-y-3">
          <div className="flex items-stretch gap-2">
            <div
              className="aspect-square w-14 shrink-0 border border-(--color-border-strong)"
              style={{
                backgroundColor: rgbToHex(value.rgb),
                boxShadow: `0 0 18px -4px ${rgbToHex(value.rgb)}`,
              }}
              aria-hidden
            />
            <div className="flex flex-1 flex-col justify-between gap-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint)">
                hex
              </span>
              <input
                type="text"
                value={hexDraft}
                onChange={(e) => {
                  const next = e.target.value;
                  setHexDraft(next);
                  const rgb = hexToRgb(next);
                  if (rgb) onChange({ mode: "rgb", rgb });
                }}
                spellCheck={false}
                className="w-full border-0 border-b border-(--color-border-strong) bg-transparent p-0 pb-1 font-mono text-2xl font-medium uppercase tracking-wider text-(--color-text) focus:border-(--color-accent) focus:outline-none focus:ring-0"
                placeholder="#RRGGBB"
                maxLength={7}
              />
              <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.25em] tabular-nums text-(--color-text-faint)">
                <span>r:{String(value.rgb.r).padStart(3, "0")}</span>
                <span>g:{String(value.rgb.g).padStart(3, "0")}</span>
                <span>b:{String(value.rgb.b).padStart(3, "0")}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-8 gap-1">
            {PRESET_COLORS.map((preset) => {
              const rgb = hexToRgb(preset.hex);
              if (!rgb) return null;
              const active =
                rgb.r === value.rgb.r &&
                rgb.g === value.rgb.g &&
                rgb.b === value.rgb.b;
              return (
                <button
                  key={preset.hex}
                  type="button"
                  onClick={() => onChange({ mode: "rgb", rgb })}
                  className={[
                    "relative aspect-square border transition",
                    active
                      ? "border-(--color-text)"
                      : "border-(--color-border) hover:border-(--color-border-strong)",
                  ].join(" ")}
                  style={{ backgroundColor: preset.hex }}
                  title={`${preset.label} ${preset.hex}`}
                  aria-label={`Pick ${preset.hex}`}
                >
                  {active ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 ring-1 ring-(--color-text)/60 ring-offset-1 ring-offset-(--color-bg)"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
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
