/**
 * Scene registry. One entry per renderable mode; each entry owns
 * its parse helper, its composer component, and the function that
 * builds the WASM-bound `ModeFrame` (the per-frame render input)
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
  clockFrameFromConfig,
  parseClockConfig,
} from "./clock";
import { ImageComposer, parseImageConfig } from "./image";
import { LifeComposer, parseLifeConfig } from "./life";
import type {
  ClockModeConfig,
  ImageModeConfig,
  LifeModeConfig,
  LifeModeFrame,
  ModeFrame,
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
  lifeFrame: LifeModeFrame;
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
  buildFrame: (config: unknown, inputs: SceneInputs) => ModeFrame;
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
  build: (config: C, inputs: SceneInputs) => ModeFrame,
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

  clock: scene<ClockModeConfig>(
    parseClockConfig,
    (config) => ({ Clock: clockFrameFromConfig(config) }),
    ClockComposer,
  ),

  life: scene<LifeModeConfig>(
    parseLifeConfig,
    (_config, inputs) => ({ Life: inputs.lifeFrame }),
    LifeComposer,
  ),

  image: scene<ImageModeConfig>(
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
};
