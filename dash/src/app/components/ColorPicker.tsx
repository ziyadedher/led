"use client";

import { Switch } from "@headlessui/react";
import { useState } from "react";

const PRESET_COLORS = [
  "#FF8A2C",
  "#FF4D6D",
  "#FFE066",
  "#A6E22E",
  "#4DE0E0",
  "#4DA3FF",
  "#A04DFF",
  "#FFFFFF",
];

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) =>
  `#${[r, g, b]
    .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;

const hexToRgb = (hex: string) => {
  const cleaned = hex.replace(/^#/, "");
  const value = cleaned.length === 3 ? cleaned.replace(/./g, "$&$&") : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

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
    <div className="space-y-3 rounded-xl border border-[--color-border] bg-[--color-surface-2] p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[--color-text-dim]">
          color
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
          className={`${value.mode === "rainbow" ? "bg-[--color-accent]" : "bg-[--color-border-strong]"} relative inline-flex h-6 w-11 items-center rounded-full transition`}
        >
          <span className="sr-only">Rainbow mode</span>
          <span
            className={`${value.mode === "rainbow" ? "translate-x-6" : "translate-x-1"} inline-block h-4 w-4 rounded-full bg-white transition`}
          />
        </Switch>
      </div>

      {value.mode === "rgb" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-8 gap-1.5">
            {PRESET_COLORS.map((preset) => {
              const rgb = hexToRgb(preset);
              if (!rgb) return null;
              const active =
                rgb.r === value.rgb.r &&
                rgb.g === value.rgb.g &&
                rgb.b === value.rgb.b;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => onChange({ mode: "rgb", rgb })}
                  className={[
                    "aspect-square rounded-md border transition hover:scale-110",
                    active
                      ? "border-white ring-2 ring-white/30"
                      : "border-[--color-border]",
                  ].join(" ")}
                  style={{ backgroundColor: preset }}
                  aria-label={`Pick ${preset}`}
                />
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <span
              className="h-9 w-9 rounded-md border border-[--color-border]"
              style={{ backgroundColor: rgbToHex(value.rgb) }}
            />
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
              className="block w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 font-mono text-sm uppercase tracking-wider text-[--color-text] focus:border-[--color-accent] focus:outline-none"
              placeholder="#RRGGBB"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <RainbowGradient />
          <div className="flex items-center gap-3 font-mono text-xs text-[--color-text-muted]">
            <span>slow</span>
            <input
              type="range"
              min={1}
              max={50}
              value={value.speed}
              onChange={(e) =>
                onChange({ ...value, speed: Number(e.target.value) })
              }
              className="flex-1 accent-[--color-accent]"
            />
            <span>fast</span>
            <span className="w-8 text-right tabular-nums text-[--color-text]">
              {value.speed}
            </span>
          </div>
          <label className="flex cursor-pointer items-center gap-2 font-mono text-xs text-[--color-text-muted]">
            <input
              type="checkbox"
              checked={value.perLetter}
              onChange={(e) =>
                onChange({ ...value, perLetter: e.target.checked })
              }
              className="h-3.5 w-3.5 rounded border-[--color-border-strong] bg-[--color-bg] text-[--color-accent] focus:ring-0 focus:ring-offset-0"
            />
            per-letter rainbow
          </label>
        </div>
      )}
    </div>
  );
}

function RainbowGradient() {
  return (
    <div
      aria-hidden
      className="h-3 w-full rounded-full"
      style={{
        background:
          "linear-gradient(90deg, #ff4d6d, #ff8a2c, #ffe066, #a6e22e, #4de0e0, #4da3ff, #a04dff, #ff4d6d)",
      }}
    />
  );
}
