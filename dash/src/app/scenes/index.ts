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
import { ImageComposer, parseImageConfig } from "./image";
import { LifeComposer, parseLifeConfig } from "./life";
import { PaintComposer, parsePaintConfig } from "./paint";
import { parseTestConfig, TestComposer } from "./test";
import type {
  ClockSceneConfig,
  ImageSceneConfig,
  LifeSceneConfig,
  LifeScene,
  Mode,
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
          entries: previewEntry ? [previewEntry] : [],
          scroll: 0,
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
  // distinction lives entirely in this composer's UX.
  paint: scene<ImageSceneConfig>(
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

  test: scene<TestSceneConfig>(
    parseTestConfig,
    (config) => ({ Test: { pattern: config.pattern } }),
    TestComposer,
  ),
};
