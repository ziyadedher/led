/**
 * Per-mode contracts shared between the dash UI and the WASM-bound
 * Frame shape. Each mode owns its own file under src/app/scenes/
 * and exports the components + helpers the page composes — keeps
 * the driver/dash frame layout isomorphic.
 */

import type { PanelMode } from "@/utils/actions";
import { LED_ORANGE } from "@/utils/color";

/**
 * Validate a raw value against a closed set of allowed literals,
 * falling back to `fallback` when it's not a member. Collapses the
 * repeated "is this one of N enum strings, else default" pattern the
 * scene parsers each re-implemented by hand.
 */
export function oneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly unknown[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Tagged union describing the contents of `display_core::Mode`.
 * Externally-tagged so JSON looks like `{ "Text": {...} }`.
 */
export type Mode =
  | { Text: TextScene }
  | { Clock: ClockScene }
  | { Life: LifeScene }
  | { Image: ImageScene }
  | { Gif: GifScene }
  | { Shapes: ShapesScene }
  | { Test: TestScene }
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

export type TextScene = {
  entries: TextEntry[];
  scroll: number;
};

export type ClockScene = {
  format: "H12" | "H24";
  show_seconds: boolean;
  show_meridiem: boolean;
  color: { r: number; g: number; b: number };
  /** Caller fills this from `new Date()` each frame. */
  now: { hour: number; minute: number; second: number };
};

/**
 * Stored in panels.mode_config for clock-mode panels. Mirrors the
 * Rust `display_core::clock::ClockSceneConfig` shape.
 */
export type ClockSceneConfig = {
  format: "H12" | "H24";
  show_seconds: boolean;
  show_meridiem: boolean;
  /**
   * IANA timezone name (e.g. "America/Los_Angeles"). When null/empty,
   * the Pi renders in its system local time and the dash sim renders
   * in the browser's local time.
   */
  timezone: string | null;
  color: { r: number; g: number; b: number };
};

export const DEFAULT_CLOCK_CONFIG: ClockSceneConfig = {
  format: "H24",
  show_seconds: false,
  show_meridiem: false,
  timezone: null,
  color: LED_ORANGE,
};

/** Fresh copy of the clock defaults (incl. a new `color` object) — a
 * shared mutable singleton would let one panel's edits leak into the
 * next parse fall-through. */
export function defaultClockConfig(): ClockSceneConfig {
  return { ...DEFAULT_CLOCK_CONFIG, color: { ...DEFAULT_CLOCK_CONFIG.color } };
}

/**
 * Game of Life. Both the dash (in TS) and the driver (in Rust) tick
 * an independent simulation locally; the dash ships its current cell
 * bitset to the WASM renderer so the preview animates without
 * round-tripping through Supabase. The driver keeps its own lattice
 * — `cells` here is just the current snapshot for whichever side is
 * doing the rendering.
 */
export type LifeScene = {
  color: { r: number; g: number; b: number };
  lattice_width: number;
  lattice_height: number;
  cells: number[];
};

/**
 * Stored in panels.mode_config for life-mode panels. Mirrors the
 * Rust `display_core::life::LifeSceneConfig` shape.
 */
export type LifeSceneConfig = {
  color: { r: number; g: number; b: number };
  /**
   * Render frames between lattice ticks. Higher → slower
   * generations. Driver runs ~60 FPS so 8 ≈ 7.5 generations/sec
   * (the original hardcoded value).
   */
  step_interval_frames: number;
};

export const DEFAULT_LIFE_CONFIG: LifeSceneConfig = {
  color: { r: 0x5d, g: 0xff, b: 0xa9 },
  step_interval_frames: 8,
};

/** Fresh copy of the life defaults — see `defaultClockConfig`. */
export function defaultLifeConfig(): LifeSceneConfig {
  return { ...DEFAULT_LIFE_CONFIG, color: { ...DEFAULT_LIFE_CONFIG.color } };
}

/**
 * Static image frame. The dash downsamples uploads/URLs to fit the
 * panel and stores raw RGBA row-major bytes (4-byte stride; length is
 * exactly `4 * width * height`). Alpha is binary on the panel side:
 * `0` = leave the pixel unset, anything else = render at full
 * intensity (the matrix has no partial transparency). Mirrors
 * `display_core::frames::image::ImageScene`.
 */
export type ImageScene = {
  width: number;
  height: number;
  bitmap: number[];
};

export type ImageSceneConfig = ImageScene & {
  /** Source filename or URL — purely cosmetic, shown in the UI. */
  source?: string;
};

/**
 * Returns a fresh copy each call — callers store this directly into
 * mode_config state, so a shared mutable singleton would let one
 * panel's edits leak into the next fall-through default.
 */
export function defaultImageConfig(): ImageSceneConfig {
  return { width: 0, height: 0, bitmap: [] };
}

/**
 * Animated GIF. The dash decodes the gif, downsamples each frame to
 * fit the panel, resolves disposal, and stores the resulting RGBA
 * frames (4-byte stride; length is exactly `4 * width * height`) +
 * per-frame delays in mode_config. Alpha is binary on the panel side
 * (`0` = transparent, e.g. disposal masks; anything else = full
 * intensity). The driver steps through the sequence based on
 * accumulated step time. Mirrors `display_core::frames::gif`.
 */
export type GifFrame = {
  bitmap: number[];
  delay_ms: number;
};

export type GifScene = {
  width: number;
  height: number;
  frames: GifFrame[];
  /**
   * Playback rate multiplier. 1.0 = native gif timing. 2.0 plays
   * twice as fast, 0.5 half-speed. The driver clamps to [0.05, 16].
   */
  speed: number;
};

export type GifSceneConfig = GifScene & {
  /** Source filename or URL — purely cosmetic, shown in the UI. */
  source?: string;
  /** Original frame count before any caps the dash applied. */
  source_frame_count?: number;
};

/**
 * Returns a fresh copy each call (incl. a new `frames` array) — see
 * `defaultImageConfig` for why a shared mutable singleton is unsafe.
 */
export function defaultGifConfig(): GifSceneConfig {
  return { width: 0, height: 0, frames: [], speed: 1 };
}

/**
 * Rotating 3-D wireframe. Picks a shape from a small catalogue
 * (cube / tetrahedron / octahedron / icosahedron / torus / hypercube)
 * and animates it on a per-frame yaw + pitch. Mirrors
 * `display_core::shapes::ShapesScene`.
 */
export type ShapeKind =
  | "Cube"
  | "Tetrahedron"
  | "Octahedron"
  | "Icosahedron"
  | "Torus"
  | "Hypercube";

export type ShapesScene = {
  kind: ShapeKind;
  color: { r: number; g: number; b: number };
  /**
   * Rotation rate. 1.0 ≈ 6 RPM around each axis. Driver clamps to
   * [0.05, 16] at render time.
   */
  speed: number;
  /**
   * Fade edges further from the camera. Reads as flicker on small
   * panels, so off by default. Independent of `opacity` — only
   * modulates the always-drawn edge silhouette.
   */
  depth_shade: boolean;
  /**
   * Face fill opacity in [0, 1]. 0 = wireframe (no fill); 1 = fully
   * opaque flat-shaded faces with back-face culling. Edges are
   * always drawn at full base color regardless.
   */
  opacity: number;
};

export type ShapesSceneConfig = ShapesScene;

export const DEFAULT_SHAPES_CONFIG: ShapesSceneConfig = {
  kind: "Cube",
  color: LED_ORANGE,
  speed: 1,
  depth_shade: false,
  opacity: 0,
};

/** Fresh copy of the shapes defaults — see `defaultClockConfig`. */
export function defaultShapesConfig(): ShapesSceneConfig {
  return { ...DEFAULT_SHAPES_CONFIG, color: { ...DEFAULT_SHAPES_CONFIG.color } };
}

/** The closed set of valid shape kinds — drives parse validation. */
export const SHAPE_KINDS: readonly ShapeKind[] = [
  "Cube",
  "Tetrahedron",
  "Octahedron",
  "Icosahedron",
  "Torus",
  "Hypercube",
];

/**
 * Test/diagnostic patterns. Render-only — no animation, no per-frame
 * state. Mirrors `display_core::test::TestPattern` + `TestScene`.
 */
export type TestPatternId = "ColorBars" | "Gradient" | "Checkerboard";

export type TestScene = {
  pattern: TestPatternId;
};

export type TestSceneConfig = TestScene;

export const DEFAULT_TEST_CONFIG: TestSceneConfig = {
  pattern: "ColorBars",
};

/** Fresh copy of the test defaults — see `defaultClockConfig`. */
export function defaultTestConfig(): TestSceneConfig {
  return { ...DEFAULT_TEST_CONFIG };
}

/** The closed set of valid test pattern ids — drives parse validation. */
export const TEST_PATTERNS: readonly TestPatternId[] = [
  "ColorBars",
  "Gradient",
  "Checkerboard",
];

export type ModeMeta = {
  id: PanelMode;
  label: string;
  blurb: string;
};

export const MODES: ModeMeta[] = [
  { id: "text", label: "text", blurb: "scrolling text payloads" },
  { id: "clock", label: "clock", blurb: "current local time" },
  { id: "image", label: "image", blurb: "static 64×64 bitmap" },
  { id: "gif", label: "gif", blurb: "animated frame loop" },
  { id: "paint", label: "paint", blurb: "pixel-grid editor" },
  { id: "shapes", label: "shapes", blurb: "rotating 3d wireframes" },
  { id: "life", label: "life", blurb: "ambient cellular automaton" },
  { id: "test", label: "test", blurb: "diagnostic patterns" },
];
