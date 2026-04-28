/**
 * Frame registry. One entry per renderable mode; each entry owns
 * its parse helper, its composer component, and the function that
 * builds the WASM-bound `ModeFrame` from saved config + ephemeral
 * inputs (e.g. typed message, current time, life lattice).
 *
 * Page.tsx looks up `FRAMES[panel.mode]` and uses its members
 * directly — adding a new mode means: write a frame module, add it
 * to PanelMode in actions.ts, add a MODES entry in types.ts, and
 * register it here.
 */

import {
  ClockComposer,
  clockFrameFromConfig,
  parseClockConfig,
} from "./clock";
import { ImageComposer, parseImageConfig } from "./image";
import { LifeComposer, parseLifeConfig, useLifeFrame } from "./life";
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
export type FrameInputs = {
  // text-mode preview
  message: string;
  color: ColorState;
  marqueeSpeed: number;
  // ephemeral state owned by the page
  lifeFrame: LifeModeFrame;
};

type ComposerProps<C> = { panelId: string; config: C };

type FrameRegistration<C> = {
  /** Parse a panels.mode_config jsonb into the typed config. */
  parse: (raw: unknown) => C;
  /** Build the runtime `ModeFrame` from saved config + page inputs. */
  buildFrame: (config: C, inputs: FrameInputs) => ModeFrame;
  /** The form rendered in the bottom half when this mode is active. */
  Composer: React.ComponentType<ComposerProps<C>>;
};

// Each entry's config type is enforced by the `satisfies
// FrameRegistration<…Config>` clause; the container is `any` to
// keep the table heterogeneous (TS can't preserve per-key generics
// in a Record). Page.tsx only ever consumes one entry at a time via
// `FRAMES[activeMode]`, and the fact that `parse → buildFrame` is
// closed over the same type per entry keeps things sound at runtime.
export const FRAMES: Record<PanelMode, FrameRegistration<any>> = {
  text: {
    parse: () => null,
    buildFrame: (_config, inputs) => {
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
    // text mode renders inline (Composer + EntriesList) in page.tsx,
    // not via a single Composer component. Stub here so TS is happy.
    Composer: (() => null) as unknown as React.ComponentType<
      ComposerProps<null>
    >,
  } satisfies FrameRegistration<null>,

  clock: {
    parse: parseClockConfig,
    buildFrame: (config: ClockModeConfig) => ({
      Clock: clockFrameFromConfig(config),
    }),
    Composer: ClockComposer,
  } satisfies FrameRegistration<ClockModeConfig>,

  life: {
    parse: parseLifeConfig,
    buildFrame: (_config, inputs) => ({ Life: inputs.lifeFrame }),
    Composer: LifeComposer,
  } satisfies FrameRegistration<LifeModeConfig>,

  image: {
    parse: parseImageConfig,
    buildFrame: (config: ImageModeConfig) => ({
      Image: {
        width: config.width,
        height: config.height,
        bitmap: config.bitmap,
      },
    }),
    Composer: ImageComposer,
  } satisfies FrameRegistration<ImageModeConfig>,
};

/**
 * Re-export `useLifeFrame` so page.tsx can keep the rAF loop alive
 * even when life isn't the active mode (for instant preview when
 * the user switches in).
 */
export { useLifeFrame };
