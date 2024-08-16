import clsx from "clsx";

import { Checkbox } from "@/components/checkbox";
import { Label, Fieldset } from "@/components/fieldset";
import { Input } from "@/components/input";

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
    <Fieldset className="flex flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-2">
        <div className="flex flex-row items-center gap-2">
          <Checkbox
            id="marquee"
            disabled={effectOptions.marquee.isForced}
            checked={effectOptions.marquee.speed > 0}
            onChange={(checked) =>
              setEffectOptions((effectOptions) => ({
                ...effectOptions,
                marquee: {
                  ...effectOptions.marquee,
                  speed: checked ? 5 : 0,
                },
              }))
            }
            className={
              effectOptions.marquee.isForced
                ? "cursor-not-allowed"
                : "cursor-pointer"
            }
          />
          <Label
            htmlFor="marquee"
            className={clsx(
              "flex flex-row items-center gap-2",
              effectOptions.marquee.isForced
                ? "cursor-not-allowed text-zinc-400 dark:text-zinc-500"
                : "cursor-pointer text-zinc-900 dark:text-zinc-100",
            )}
          >
            <span className="font-medium text-zinc-950 dark:text-white">
              Marquee
            </span>{" "}
            <p className="text-xs text-zinc-400">makes it sliiiide over.</p>
          </Label>
        </div>

        <div className="flex flex-col gap-1">
          <Input
            id="marquee-speed"
            type="range"
            min={1}
            max={15}
            value={effectOptions.marquee.speed}
            onChange={(e) => {
              setEffectOptions((effectOptions) => ({
                ...effectOptions,
                marquee: {
                  ...effectOptions.marquee,
                  speed: Number(e.target.value),
                },
              }));
            }}
            disabled={effectOptions.marquee.speed === 0}
          />
          <Label
            htmlFor="marquee-speed"
            className="flex w-full flex-row justify-between"
          >
            <span className="text-xs text-zinc-400">Slow</span>
            <span className="text-xs text-zinc-400">
              {effectOptions.marquee.speed}
            </span>
            <span className="text-xs text-zinc-400">Fast</span>
          </Label>
        </div>
      </div>
    </Fieldset>
  </div>
);

export default Effects;
