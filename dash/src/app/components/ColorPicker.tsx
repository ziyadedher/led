"use client";

import { Switch } from "@headlessui/react";
import { useState } from "react";

import { CheckRow } from "@/app/components/CheckRow";
import { Fader } from "@/app/components/Fader";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { FOCUS_RING, MicroLabel } from "@/app/components/ui";
import { LED_ORANGE } from "@/utils/color";

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

type RgbState = Extract<ColorState, { mode: "rgb" }>;
type RainbowState = Extract<ColorState, { mode: "rainbow" }>;

const DEFAULT_RGB: RgbState = { mode: "rgb", rgb: LED_ORANGE };
const DEFAULT_RAINBOW: RainbowState = {
  mode: "rainbow",
  perLetter: false,
  speed: 16,
};

export function ColorPicker({
  value,
  onChange,
}: {
  value: ColorState;
  onChange: (c: ColorState) => void;
}) {
  // Remember the last-seen sub-state for each mode so toggling
  // rgb→rainbow→rgb restores the user's color (and the rainbow
  // speed/per-letter) instead of hard-resetting to LED-orange. The
  // stashes are updated through `commit` (an event-handler path), and
  // the incoming `value` seeds whichever mode is currently active.
  const [lastRgb, setLastRgb] = useState<RgbState>(
    value.mode === "rgb" ? value : DEFAULT_RGB,
  );
  const [lastRainbow, setLastRainbow] = useState<RainbowState>(
    value.mode === "rainbow" ? value : DEFAULT_RAINBOW,
  );

  // Forward an edit to the parent and stash it as the last-known
  // sub-state for its mode.
  const commit = (next: ColorState) => {
    if (next.mode === "rgb") setLastRgb(next);
    else setLastRainbow(next);
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <MicroLabel>color</MicroLabel>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          <span className={value.mode === "rgb" ? "text-(--color-text)" : ""}>
            rgb
          </span>
          {/* The button is the 24×36 hit box; the painted track inside
           * stays slim so the toggle doesn't visually bloat. */}
          <Switch
            checked={value.mode === "rainbow"}
            onChange={(on) => onChange(on ? lastRainbow : lastRgb)}
            className={`relative inline-flex h-6 w-9 items-center ${FOCUS_RING}`}
          >
            <span className="sr-only">Rainbow mode</span>
            <span
              aria-hidden
              className={[
                "inline-flex h-5 w-9 items-center rounded-sm border transition",
                value.mode === "rainbow"
                  ? "border-(--color-accent) bg-(--color-accent)/15"
                  : "border-(--color-border-strong) bg-(--color-surface-2)",
              ].join(" ")}
            >
              <span
                className={[
                  "inline-block h-3.5 w-3.5 rounded-[1px] transition-transform",
                  value.mode === "rainbow"
                    ? "translate-x-[18px] bg-(--color-accent) shadow-[0_0_6px_var(--color-accent)]"
                    : "translate-x-0.5 bg-(--color-text-dim)",
                ].join(" ")}
              />
            </span>
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
          onChange={(rgb) => commit({ mode: "rgb", rgb })}
        />
      ) : (
        <div className="space-y-3">
          <div
            aria-hidden
            className="h-3 w-full"
            style={{
              background:
                "linear-gradient(90deg, var(--color-swatch-rose), var(--color-swatch-amber), var(--color-swatch-sun), var(--color-swatch-lime), var(--color-swatch-cyan), var(--color-swatch-azure), var(--color-swatch-violet), var(--color-swatch-rose))",
            }}
          />
          <Fader
            label="speed"
            value={value.speed}
            min={1}
            max={50}
            step={1}
            onChange={(speed) => commit({ ...value, speed })}
            format={(v) => String(v).padStart(2, "0")}
            endpoints={["slow", "fast"]}
            ariaLabel="Rainbow speed"
          />
          <CheckRow
            sigil={false}
            label="per-letter phase"
            checked={value.perLetter}
            onChange={(perLetter) => commit({ ...value, perLetter })}
          />
        </div>
      )}
    </div>
  );
}
