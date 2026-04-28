/**
 * Per-mode contracts shared between the dash UI and the WASM-bound
 * Frame shape. Each mode owns its own file under src/app/frames/
 * and exports the components + helpers the page composes — keeps
 * the driver/dash frame layout isomorphic.
 */

import type { PanelMode } from "@/utils/actions";

/**
 * Tagged union describing the contents of `display_core::Mode`.
 * Externally-tagged so JSON looks like `{ "Text": {...} }`.
 */
export type ModeFrame =
  | { Text: TextModeFrame }
  | { Clock: ClockModeFrame }
  | { Life: LifeModeFrame }
  | { Image: ImageModeFrame }
  // Driver-only frames the dash never constructs but the type
  // includes for completeness with display_core::Mode. The simulator
  // would render them correctly if it ever received one.
  | { Boot: { color: { r: number; g: number; b: number } } }
  | {
      Setup: {
        color: { r: number; g: number; b: number };
        ssid: string;
        portal_url: string;
      };
    };

export type TextEntry = {
  text: string;
  options: { color: WireColor; marquee: { speed: number } };
};

export type WireColor =
  | { Rgb: { r: number; g: number; b: number } }
  | { Rainbow: { is_per_letter: boolean; speed: number } };

export type TextModeFrame = {
  entries: TextEntry[];
  scroll: number;
};

export type ClockModeFrame = {
  format: "H12" | "H24";
  show_seconds: boolean;
  show_meridiem: boolean;
  color: { r: number; g: number; b: number };
  /** Caller fills this from `new Date()` each frame. */
  now: { hour: number; minute: number; second: number };
};

/** Stored in panels.mode_config for clock-mode panels. */
export type ClockModeConfig = {
  format: "H12" | "H24";
  show_seconds: boolean;
  show_meridiem: boolean;
  color: { r: number; g: number; b: number };
};

export const DEFAULT_CLOCK_CONFIG: ClockModeConfig = {
  format: "H24",
  show_seconds: false,
  show_meridiem: false,
  color: { r: 0xff, g: 0x8a, b: 0x2c },
};

/**
 * Game of Life. Both the dash (in TS) and the driver (in Rust) tick
 * an independent simulation locally; the dash ships its current cell
 * bitset to the WASM renderer so the preview animates without
 * round-tripping through Supabase. The driver keeps its own lattice
 * — `cells` here is just the current snapshot for whichever side is
 * doing the rendering.
 */
export type LifeModeFrame = {
  color: { r: number; g: number; b: number };
  lattice_width: number;
  lattice_height: number;
  cells: number[];
};

/** Stored in panels.mode_config for life-mode panels. */
export type LifeModeConfig = {
  color: { r: number; g: number; b: number };
};

export const DEFAULT_LIFE_CONFIG: LifeModeConfig = {
  color: { r: 0x5d, g: 0xff, b: 0xa9 },
};

/**
 * Static image frame. The dash downsamples uploads/URLs to fit the
 * panel and stores raw RGB888 row-major bytes. Black pixels are
 * treated as transparent on the panel side (matches the gif
 * decoder's transparent-pixel convention).
 */
export type ImageModeFrame = {
  width: number;
  height: number;
  bitmap: number[];
};

export type ImageModeConfig = ImageModeFrame & {
  /** Source filename or URL — purely cosmetic, shown in the UI. */
  source?: string;
};

export const DEFAULT_IMAGE_CONFIG: ImageModeConfig = {
  width: 0,
  height: 0,
  bitmap: [],
};

export type ModeMeta = {
  id: PanelMode;
  label: string;
  blurb: string;
};

export const MODES: ModeMeta[] = [
  { id: "text", label: "text", blurb: "scrolling text payloads" },
  { id: "clock", label: "clock", blurb: "current local time" },
  { id: "image", label: "image", blurb: "static 64×64 bitmap" },
  { id: "life", label: "life", blurb: "ambient cellular automaton" },
];
