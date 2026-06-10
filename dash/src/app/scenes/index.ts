/**
 * Scene registry. One entry per renderable mode; each entry owns
 * its parse helper, its composer component, and the function that
 * builds the WASM-bound `Mode` payload (the per-tick render input)
 * from saved config + ephemeral inputs (typed message, current
 * time, life lattice).
 *
 * Page.tsx looks up `SCENES[panel.mode]` and uses its members
 * directly — adding a new scene means: write a module under
 * src/app/scenes/, add it to PanelMode in actions.ts, add a MODES
 * entry in types.ts, and register it here.
 */

import {
  ClockComposer,
  clockSceneFromConfig,
  parseClockConfig,
} from "./clock";
import { FireComposer, parseFireConfig } from "./fire";
import { FluidComposer, parseFluidConfig } from "./fluid";
import { FxComposer, parseFxConfig } from "./fx";
import { GifComposer, parseGifConfig } from "./gif";
import { ImageComposer, parseImageConfig } from "./image";
import { LavaComposer, parseLavaConfig } from "./lava";
import { LifeComposer, parseLifeConfig } from "./life";
import { PaintComposer, parsePaintConfig, type PaintSceneConfig } from "./paint";
import { parsePhysarumConfig, PhysarumComposer } from "./physarum";
import { parsePlasmaConfig, PlasmaComposer } from "./plasma";
import { parsePongConfig, PongComposer, pongSceneFromConfig } from "./pong";
import { parseRainConfig, RainComposer } from "./rain";
import { parseRdConfig, RdComposer } from "./rd";
import { parseSandConfig, SandComposer } from "./sand";
import { parseShapesConfig, ShapesComposer } from "./shapes";
import { parseSkyConfig, SkyComposer, skySceneFromConfig } from "./sky";
import { parseStarfieldConfig, StarfieldComposer } from "./starfield";
import { parseSwarmConfig, SwarmComposer } from "./swarm";
import { parseTestConfig, TestComposer } from "./test";
import { parseWarpConfig, WarpComposer } from "./warp";
import type {
  ClockSceneConfig,
  FireSceneConfig,
  GifSceneConfig,
  ImageSceneConfig,
  FluidSceneConfig,
  FxSceneConfig,
  LavaSceneConfig,
  LifeSceneConfig,
  PhysarumSceneConfig,
  PongSceneConfig,
  RdSceneConfig,
  SandSceneConfig,
  SkySceneConfig,
  SwarmSceneConfig,
  WarpSceneConfig,
  LifeScene,
  Mode,
  PlasmaSceneConfig,
  RainSceneConfig,
  ShapesSceneConfig,
  StarfieldSceneConfig,
  TestSceneConfig,
  TextEntry,
} from "./types";

import type { ColorState } from "@/app/components/ColorPicker";
import type { PanelMode } from "@/utils/actions";

/** Inputs every frame's `buildFrame` may use. */
export type SceneInputs = {
  // text-mode preview
  message: string;
  color: ColorState;
  marqueeSpeed: number;
  // ephemeral state owned by the page
  lifeScene: LifeScene;
};

type ComposerProps<C> = { panelId: string; config: C };

/**
 * Erased registration shape used by the registry. Each entry's
 * config type is encapsulated inside the entry — parse(raw)
 * produces the typed config, buildFrame consumes it, Composer
 * receives it. The outer types are `unknown` so the registry can
 * hold heterogeneous entries in one Record without per-key generics.
 */
type SceneRegistration = {
  parse: (raw: unknown) => unknown;
  buildFrame: (config: unknown, inputs: SceneInputs) => Mode;
  Composer: React.ComponentType<ComposerProps<unknown>>;
};

/**
 * Builder helper. Take a strongly-typed parse + buildFrame +
 * Composer triple and erase to SceneRegistration. The single cast
 * here is sound because the parse output, buildFrame input, and
 * Composer config prop are all bound to the same `C` per call.
 */
function scene<C>(
  parse: (raw: unknown) => C,
  build: (config: C, inputs: SceneInputs) => Mode,
  Composer: React.ComponentType<ComposerProps<C>>,
): SceneRegistration {
  return {
    parse,
    buildFrame: (config, inputs) => build(config as C, inputs),
    Composer: Composer as React.ComponentType<ComposerProps<unknown>>,
  };
}

// Text mode renders inline (Composer + EntriesList) in page.tsx,
// not via a single Composer component. Stub Composer here.
const TextComposerStub: React.ComponentType<ComposerProps<null>> = () => null;

export const SCENES: Record<PanelMode, SceneRegistration> = {
  text: scene<null>(
    () => null,
    (_config, inputs) => {
      const previewEntry: TextEntry | null =
        inputs.message.length > 0
          ? {
              text: inputs.message,
              options: {
                color:
                  inputs.color.mode === "rgb"
                    ? { Rgb: inputs.color.rgb }
                    : {
                        Rainbow: {
                          is_per_letter: inputs.color.perLetter,
                          speed: inputs.color.speed,
                        },
                      },
                marquee: { speed: inputs.marqueeSpeed },
              },
            }
          : null;
      return {
        Text: {
          // EntriesList drives the stored entries; MatrixPreview folds
          // them in. The page only contributes the live preview.
          // `scroll` is deliberately omitted so MatrixPreview can fill
          // in the live panel scroll before handing the frame to WASM.
          entries: previewEntry ? [previewEntry] : [],
        },
      };
    },
    TextComposerStub,
  ),

  clock: scene<ClockSceneConfig>(
    parseClockConfig,
    (config) => ({ Clock: clockSceneFromConfig(config) }),
    ClockComposer,
  ),

  life: scene<LifeSceneConfig>(
    parseLifeConfig,
    (_config, inputs) => ({ Life: inputs.lifeScene }),
    LifeComposer,
  ),

  image: scene<ImageSceneConfig>(
    parseImageConfig,
    (config) => ({
      Image: {
        width: config.width,
        height: config.height,
        bitmap: config.bitmap,
      },
    }),
    ImageComposer,
  ),

  // Paint shares Image's render path on both sides of the wire — the
  // distinction lives entirely in this composer's UX. Paint also
  // persists a sticky brush `color` the renderer ignores.
  paint: scene<PaintSceneConfig>(
    parsePaintConfig,
    (config) => ({
      Image: {
        width: config.width,
        height: config.height,
        bitmap: config.bitmap,
      },
    }),
    PaintComposer,
  ),

  gif: scene<GifSceneConfig>(
    parseGifConfig,
    (config) => ({
      Gif: {
        width: config.width,
        height: config.height,
        frames: config.frames,
        speed: config.speed,
      },
    }),
    GifComposer,
  ),

  shapes: scene<ShapesSceneConfig>(
    parseShapesConfig,
    (config) => ({ Shapes: config }),
    ShapesComposer,
  ),

  // Stateless ambient scenes — scene == config, passed straight
  // through to the renderer; `step` drives all motion on both sides.
  plasma: scene<PlasmaSceneConfig>(
    parsePlasmaConfig,
    (config) => ({ Plasma: config }),
    PlasmaComposer,
  ),

  fire: scene<FireSceneConfig>(
    parseFireConfig,
    (config) => ({ Fire: config }),
    FireComposer,
  ),

  rain: scene<RainSceneConfig>(
    parseRainConfig,
    (config) => ({ Rain: config }),
    RainComposer,
  ),

  starfield: scene<StarfieldSceneConfig>(
    parseStarfieldConfig,
    (config) => ({ Starfield: config }),
    StarfieldComposer,
  ),

  lava: scene<LavaSceneConfig>(
    parseLavaConfig,
    (config) => ({ Lava: config }),
    LavaComposer,
  ),

  warp: scene<WarpSceneConfig>(
    parseWarpConfig,
    (config) => ({ Warp: config }),
    WarpComposer,
  ),

  fx: scene<FxSceneConfig>(
    parseFxConfig,
    (config) => ({ Fx: config }),
    FxComposer,
  ),

  // Time-injected scenes — buildFrame samples the wall clock, like
  // clock; page.tsx's minute-gated memo dep keeps them fresh.
  sky: scene<SkySceneConfig>(
    parseSkyConfig,
    (config) => ({ Sky: skySceneFromConfig(config) }),
    SkyComposer,
  ),

  pong: scene<PongSceneConfig>(
    parsePongConfig,
    (config) => ({ Pong: pongSceneFromConfig(config) }),
    PongComposer,
  ),

  // Stateful sims — the wire payload is config only; the WASM
  // renderer (and the driver) hold the evolving state in a SimHost.
  physarum: scene<PhysarumSceneConfig>(
    parsePhysarumConfig,
    (config) => ({ Physarum: config }),
    PhysarumComposer,
  ),

  rd: scene<RdSceneConfig>(
    parseRdConfig,
    (config) => ({ Rd: config }),
    RdComposer,
  ),

  fluid: scene<FluidSceneConfig>(
    parseFluidConfig,
    (config) => ({ Fluid: config }),
    FluidComposer,
  ),

  sand: scene<SandSceneConfig>(
    parseSandConfig,
    (config) => ({ Sand: config }),
    SandComposer,
  ),

  swarm: scene<SwarmSceneConfig>(
    parseSwarmConfig,
    (config) => ({ Swarm: config }),
    SwarmComposer,
  ),

  test: scene<TestSceneConfig>(
    parseTestConfig,
    (config) => ({ Test: { pattern: config.pattern } }),
    TestComposer,
  ),
};
