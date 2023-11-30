import cx from "classnames";
import { Checkbox, Label, Tooltip } from "flowbite-react";

export const FORCE_ENABLE_MARQUEE_LENGTH = 12;

export const generateRandomEffectOptions = (): EffectOptions => ({
  marquee: {
    isForced: false,
    speed: Math.floor(Math.random() * 5) + 5,
  },
});

export type EffectOptions = {
  marquee: {
    isForced: boolean;
    speed: number;
  };
};

const Effects = ({
  effectOptions,
  setEffectOptions,
}: {
  effectOptions: EffectOptions;
  setEffectOptions: (
    options: EffectOptions | ((options: EffectOptions) => EffectOptions),
  ) => void;
}) => (
  <div className="flex max-w-lg flex-col items-center gap-4">
    <h2 className="border-b border-gray-300 pb-2 text-xs text-gray-500">
      Make it special
    </h2>
    <fieldset className="flex flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-2">
        <Tooltip
          content={`Marquee is force-enabled when the text is longer than ${FORCE_ENABLE_MARQUEE_LENGTH} characters.`}
        >
          <div className="flex flex-row items-center gap-2">
            <Checkbox
              id="marquee"
              disabled={effectOptions.marquee.isForced}
              checked={effectOptions.marquee.speed > 0}
              onChange={(e) =>
                setEffectOptions((effectOptions) => ({
                  ...effectOptions,
                  marquee: {
                    ...effectOptions.marquee,
                    speed: e.target.checked ? 5 : 0,
                  },
                }))
              }
              className={cx(
                effectOptions.marquee.isForced
                  ? "cursor-not-allowed"
                  : "cursor-pointer",
              )}
            />
            <Label
              htmlFor="marquee"
              disabled={effectOptions.marquee.isForced}
              className={cx(
                effectOptions.marquee.isForced
                  ? "cursor-not-allowed"
                  : "cursor-pointer",
              )}
            >
              <span className="font-medium text-gray-900">Marquee</span>{" "}
              <span className="text-gray-500">makes it sliiiide over.</span>
            </Label>
          </div>
        </Tooltip>
        {effectOptions.marquee.speed > 0 ? (
          <div className="flex flex-row items-center gap-2">
            <Label htmlFor="marquee-speed" className="text-gray-500">
              Slow
            </Label>
            <input
              id="marquee-speed"
              type="range"
              min="1"
              max="15"
              value={effectOptions.marquee.speed}
              onChange={(e) =>
                setEffectOptions((effectOptions) => ({
                  ...effectOptions,
                  marquee: {
                    ...effectOptions.marquee,
                    speed: Number(e.target.value),
                  },
                }))
              }
            />
            <Label htmlFor="marquee-speed" className="text-gray-500">
              Fast
            </Label>
          </div>
        ) : null}
      </div>
    </fieldset>
  </div>
);

export default Effects;
