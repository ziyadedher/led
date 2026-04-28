/**
 * Per-mode contracts shared between the dash UI and the WASM-bound
 * Frame shape. Each mode owns its own file under src/app/modes/ and
 * exports the components + helpers the page composes — keeps the
 * driver/dash modes isomorphic by file layout.
 */

import type { PanelMode } from "@/utils/actions";

/**
 * Tagged union describing the contents of `display_core::Mode`.
 * Externally-tagged so JSON looks like `{ "Text": {...} }`.
 */
export type ModeFrame =
  | { Text: TextModeFrame }
  | { Clock: ClockModeFrame };

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

export type ModeMeta = {
  id: PanelMode;
  label: string;
  blurb: string;
};

export const MODES: ModeMeta[] = [
  { id: "text", label: "text", blurb: "scrolling text payloads" },
  { id: "clock", label: "clock", blurb: "current local time" },
];
