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
  | { Plasma: PlasmaScene }
  | { Fire: FireScene }
  | { Rain: RainScene }
  | { Starfield: StarfieldScene }
  | { Lava: LavaScene }
  | { Warp: WarpScene }
  | { Fx: FxScene }
  | { Sky: SkyScene }
  | { Pong: PongScene }
  | { Physarum: PhysarumSceneConfig }
  | { Rd: RdSceneConfig }
  | { Fluid: FluidSceneConfig }
  | { Sand: SandSceneConfig }
  | { Swarm: SwarmSceneConfig }
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
  /**
   * Vertical scroll offset in pixels. The dash-side builder leaves
   * this undefined so MatrixPreview can fill in the live panel scroll
   * before serializing for WASM (the Rust side has #[serde(default)]).
   */
  scroll?: number;
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

/* ── stateless ambient scenes ─────────────────────────────────────
 * Scene == config for all five: they're pure functions of
 * (config, step) on both sides of the wire, so the dash stores the
 * same struct it renders. Each mirrors its Rust twin in
 * `display_core::frames::<mode>` — field names and defaults must
 * stay in lockstep. */

export type PlasmaPalette = "Ember" | "Phosphor" | "Aurora" | "Rainbow";

export type PlasmaScene = {
  palette: PlasmaPalette;
  /** Animation rate; driver clamps to [0.05, 8]. */
  speed: number;
  /** Spatial scale — higher = larger blobs; driver clamps [0.25, 4]. */
  scale: number;
};

export type PlasmaSceneConfig = PlasmaScene;

export const PLASMA_PALETTES: readonly PlasmaPalette[] = [
  "Ember",
  "Phosphor",
  "Aurora",
  "Rainbow",
];

export const DEFAULT_PLASMA_CONFIG: PlasmaSceneConfig = {
  palette: "Ember",
  speed: 1,
  scale: 1,
};

/** Fresh copy of the plasma defaults — see `defaultClockConfig`. */
export function defaultPlasmaConfig(): PlasmaSceneConfig {
  return { ...DEFAULT_PLASMA_CONFIG };
}

export type FirePalette = "Classic" | "Gas" | "Phosphor";

export type FireScene = {
  palette: FirePalette;
  /** Flame height / seed temperature in [0, 1]. */
  intensity: number;
  /** Lateral bias in [-1, 1]; negative leans left. */
  wind: number;
  /** Occasional detached sparks above the flame tips. */
  embers: boolean;
};

export type FireSceneConfig = FireScene;

export const FIRE_PALETTES: readonly FirePalette[] = [
  "Classic",
  "Gas",
  "Phosphor",
];

export const DEFAULT_FIRE_CONFIG: FireSceneConfig = {
  palette: "Classic",
  intensity: 0.8,
  wind: 0,
  embers: true,
};

/** Fresh copy of the fire defaults — see `defaultClockConfig`. */
export function defaultFireConfig(): FireSceneConfig {
  return { ...DEFAULT_FIRE_CONFIG };
}

export type RainScene = {
  color: { r: number; g: number; b: number };
  /** Fraction of columns carrying an active stream, in [0, 1]. */
  density: number;
  /** Fall rate; driver clamps to [0.1, 4]. */
  speed: number;
  /** Tail length in pixels; driver clamps to [2, 48]. */
  tail: number;
};

export type RainSceneConfig = RainScene;

export const DEFAULT_RAIN_CONFIG: RainSceneConfig = {
  color: { r: 0x5d, g: 0xff, b: 0xa9 },
  density: 0.5,
  speed: 1,
  tail: 14,
};

/** Fresh copy of the rain defaults — see `defaultClockConfig`. */
export function defaultRainConfig(): RainSceneConfig {
  return { ...DEFAULT_RAIN_CONFIG, color: { ...DEFAULT_RAIN_CONFIG.color } };
}

export type StarfieldScene = {
  /** Star color when `thermal` is off. */
  color: { r: number; g: number; b: number };
  /** Flight speed; above ~3 stars streak. Driver clamps [0.1, 8]. */
  warp: number;
  /** Concurrent stars; driver clamps [8, 256]. */
  density: number;
  /** Map approach speed to color (blue → white → orange). */
  thermal: boolean;
  /** Subtle per-star shimmer at low warp. */
  twinkle: boolean;
};

export type StarfieldSceneConfig = StarfieldScene;

export const DEFAULT_STARFIELD_CONFIG: StarfieldSceneConfig = {
  color: { r: 0xff, g: 0xff, b: 0xff },
  warp: 1,
  density: 80,
  thermal: false,
  twinkle: true,
};

/** Fresh copy of the starfield defaults — see `defaultClockConfig`. */
export function defaultStarfieldConfig(): StarfieldSceneConfig {
  return {
    ...DEFAULT_STARFIELD_CONFIG,
    color: { ...DEFAULT_STARFIELD_CONFIG.color },
  };
}

export type LavaScene = {
  /** Blob core color. */
  color: { r: number; g: number; b: number };
  /** Background glow color (the "lamp fluid"). */
  glow: { r: number; g: number; b: number };
  /** Concurrent blobs; driver clamps [2, 8]. */
  blob_count: number;
  /** Drift rate; driver clamps [0.05, 4]. */
  speed: number;
  /** Threshold softness [0, 1]: 0 = crisp blobs, 1 = nebula. */
  goo: number;
};

export type LavaSceneConfig = LavaScene;

export const DEFAULT_LAVA_CONFIG: LavaSceneConfig = {
  color: { r: 0xff, g: 0x8a, b: 0x2c },
  glow: { r: 0x1a, g: 0x04, b: 0x00 },
  blob_count: 5,
  speed: 1,
  goo: 0.5,
};

/** Fresh copy of the lava defaults — see `defaultClockConfig`. */
export function defaultLavaConfig(): LavaSceneConfig {
  return {
    ...DEFAULT_LAVA_CONFIG,
    color: { ...DEFAULT_LAVA_CONFIG.color },
    glow: { ...DEFAULT_LAVA_CONFIG.glow },
  };
}


/* ── second-wave scenes ───────────────────────────────────────────
 * Same lockstep rule as the first wave: every field/default mirrors
 * the Rust twin in display_core::frames::<mode>. The sim modes
 * (physarum/rd/fluid/sand/swarm) carry CONFIG only — their state
 * lives in display-core's SimHost on both the driver and inside the
 * WASM preview, so the dash never simulates them in TS. */

type RgbV = { r: number; g: number; b: number };

export type WarpPalette = "Ember" | "Phosphor" | "Aurora" | "Ocean" | "Rainbow";
export const WARP_PALETTES: readonly WarpPalette[] = ["Ember", "Phosphor", "Aurora", "Ocean", "Rainbow"];
export type WarpScene = { palette: WarpPalette; speed: number; scale: number };
export type WarpSceneConfig = WarpScene;
export const DEFAULT_WARP_CONFIG: WarpSceneConfig = { palette: "Ember", speed: 1, scale: 1 };
export function defaultWarpConfig(): WarpSceneConfig { return { ...DEFAULT_WARP_CONFIG }; }

export type FxEffect =
  | "Tunnel" | "Rotozoom" | "Twister" | "Copper" | "Moire"
  | "Kefrens" | "Julia" | "Chladni" | "Aurora" | "BlackHole";
export const FX_EFFECTS: readonly FxEffect[] = [
  "Tunnel", "Rotozoom", "Twister", "Copper", "Moire",
  "Kefrens", "Julia", "Chladni", "Aurora", "BlackHole",
];
export type FxPalette = "Ember" | "Phosphor" | "Aurora" | "Rainbow";
export const FX_PALETTES: readonly FxPalette[] = ["Ember", "Phosphor", "Aurora", "Rainbow"];
export type FxScene = { effect: FxEffect; palette: FxPalette; speed: number };
export type FxSceneConfig = FxScene;
export const DEFAULT_FX_CONFIG: FxSceneConfig = { effect: "Tunnel", palette: "Ember", speed: 1 };
export function defaultFxConfig(): FxSceneConfig { return { ...DEFAULT_FX_CONFIG }; }

export type SkyFace = "Moon" | "Sun" | "Terminator";
export const SKY_FACES: readonly SkyFace[] = ["Moon", "Sun", "Terminator"];
/** UTC sample injected by buildFrame each minute-tick. */
export type SkyTime = { year: number; month: number; day: number; hour: number; minute: number };
export type SkySceneConfig = { face: SkyFace; lat: number; lon: number; color: RgbV };
export type SkyScene = SkySceneConfig & { now: SkyTime };
export const DEFAULT_SKY_CONFIG: SkySceneConfig = {
  face: "Moon", lat: 0, lon: 0, color: { r: 0xff, g: 0xe0, b: 0xb0 },
};
export function defaultSkyConfig(): SkySceneConfig {
  return { ...DEFAULT_SKY_CONFIG, color: { ...DEFAULT_SKY_CONFIG.color } };
}

export type PongFormat = "H24" | "H12";
export type PongSceneConfig = { color: RgbV; speed: number; format: PongFormat };
export type PongScene = PongSceneConfig & {
  now: { hour: number; minute: number; second: number };
};
export const DEFAULT_PONG_CONFIG: PongSceneConfig = {
  color: { r: 0xe6, g: 0xe6, b: 0xea }, speed: 1, format: "H24",
};
export function defaultPongConfig(): PongSceneConfig {
  return { ...DEFAULT_PONG_CONFIG, color: { ...DEFAULT_PONG_CONFIG.color } };
}

export type PhysarumSceneConfig = { color: RgbV; agents: number; decay: number; speed: number };
export const DEFAULT_PHYSARUM_CONFIG: PhysarumSceneConfig = {
  color: { r: 0x5d, g: 0xff, b: 0xa9 }, agents: 3000, decay: 0.94, speed: 1,
};
export function defaultPhysarumConfig(): PhysarumSceneConfig {
  return { ...DEFAULT_PHYSARUM_CONFIG, color: { ...DEFAULT_PHYSARUM_CONFIG.color } };
}

export type RdSceneConfig = { color: RgbV; feed: number; kill: number; drift: boolean; speed: number };
export const DEFAULT_RD_CONFIG: RdSceneConfig = {
  color: { r: 0x4d, g: 0xe0, b: 0xe0 }, feed: 0.0545, kill: 0.062, drift: true, speed: 1,
};
export function defaultRdConfig(): RdSceneConfig {
  return { ...DEFAULT_RD_CONFIG, color: { ...DEFAULT_RD_CONFIG.color } };
}

export type FluidSceneConfig = { color_a: RgbV; color_b: RgbV; swirl: number; speed: number };
export const DEFAULT_FLUID_CONFIG: FluidSceneConfig = {
  color_a: { r: 0xff, g: 0x8a, b: 0x2c }, color_b: { r: 0x4d, g: 0xa3, b: 0xff }, swirl: 1, speed: 1,
};
export function defaultFluidConfig(): FluidSceneConfig {
  return {
    ...DEFAULT_FLUID_CONFIG,
    color_a: { ...DEFAULT_FLUID_CONFIG.color_a },
    color_b: { ...DEFAULT_FLUID_CONFIG.color_b },
  };
}

export type SandSceneConfig = { color: RgbV; rainbow: boolean; pour_rate: number; reset_minutes: number };
export const DEFAULT_SAND_CONFIG: SandSceneConfig = {
  color: { r: 0xff, g: 0x8a, b: 0x2c }, rainbow: true, pour_rate: 1, reset_minutes: 0,
};
export function defaultSandConfig(): SandSceneConfig {
  return { ...DEFAULT_SAND_CONFIG, color: { ...DEFAULT_SAND_CONFIG.color } };
}

export type SwarmSceneConfig = { color: RgbV; count: number; trail: number; speed: number };
export const DEFAULT_SWARM_CONFIG: SwarmSceneConfig = {
  color: { r: 0x4d, g: 0xa3, b: 0xff }, count: 60, trail: 0.9, speed: 1,
};
export function defaultSwarmConfig(): SwarmSceneConfig {
  return { ...DEFAULT_SWARM_CONFIG, color: { ...DEFAULT_SWARM_CONFIG.color } };
}

/** Mode-switcher grouping. The flat tile grid stopped scaling past
 * a dozen modes; tiles render per-category in the switcher. */
export type ModeCategory = "signal" | "canvas" | "ambient" | "lab" | "diag";

export const MODE_CATEGORIES: { id: ModeCategory; label: string; blurb: string }[] = [
  { id: "signal", label: "signal", blurb: "words & time" },
  { id: "canvas", label: "canvas", blurb: "your pixels" },
  { id: "ambient", label: "ambient", blurb: "procedural motion" },
  { id: "lab", label: "lab", blurb: "living simulations" },
  { id: "diag", label: "diag", blurb: "panel health" },
];

export type ModeMeta = {
  id: PanelMode;
  label: string;
  blurb: string;
  category: ModeCategory;
};

export const MODES: ModeMeta[] = [
  { id: "text", label: "text", blurb: "scrolling text payloads", category: "signal" },
  { id: "clock", label: "clock", blurb: "current local time", category: "signal" },
  { id: "pong", label: "pong clock", blurb: "the score is the time", category: "signal" },
  { id: "sky", label: "sky", blurb: "moon · sun · terminator", category: "signal" },
  { id: "image", label: "image", blurb: "static 64×64 bitmap", category: "canvas" },
  { id: "gif", label: "gif", blurb: "animated frame loop", category: "canvas" },
  { id: "paint", label: "paint", blurb: "pixel-grid editor", category: "canvas" },
  { id: "plasma", label: "plasma", blurb: "drifting sine fields", category: "ambient" },
  { id: "warp", label: "warp", blurb: "domain-warped noise flow", category: "ambient" },
  { id: "fire", label: "fire", blurb: "procedural flame", category: "ambient" },
  { id: "rain", label: "rain", blurb: "digital rain streams", category: "ambient" },
  { id: "starfield", label: "starfield", blurb: "warp toward the glass", category: "ambient" },
  { id: "lava", label: "lava", blurb: "slow metaball lamp", category: "ambient" },
  { id: "fx", label: "fx", blurb: "demoscene effect pack", category: "ambient" },
  { id: "shapes", label: "shapes", blurb: "rotating 3d wireframes", category: "ambient" },
  { id: "life", label: "life", blurb: "ambient cellular automaton", category: "lab" },
  { id: "physarum", label: "physarum", blurb: "slime-mold vein networks", category: "lab" },
  { id: "rd", label: "reaction", blurb: "gray-scott diffusion", category: "lab" },
  { id: "fluid", label: "fluid", blurb: "dye in a stable-fluids field", category: "lab" },
  { id: "sand", label: "sand", blurb: "falling grains · hourglass", category: "lab" },
  { id: "swarm", label: "swarm", blurb: "boids with light trails", category: "lab" },
  { id: "test", label: "test", blurb: "diagnostic patterns", category: "diag" },
];
