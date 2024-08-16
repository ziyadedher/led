"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useSWRConfig } from "swr";

import Message from "@/app/components/message";
import Status from "@/app/components/status";
import Colors, {
  type ColorOptions,
  generateRandomColorOptions,
} from "@/app/components/colors";
import Controls from "@/app/components/controls";
import Effects, {
  generateRandomEffectOptions,
  FORCE_ENABLE_MARQUEE_LENGTH,
} from "@/app/components/effects";
import Entries from "@/app/components/entries";
import { entries } from "@/utils/actions";
import { Divider } from "@/components/divider";

export default function RootPage() {
  const { mutate } = useSWRConfig();

  const [message, setMessage] = useState("");
  const isSubmitable = useMemo(() => message.length > 0, [message]);

  const [colorOptions, setColorOptions] = useState<ColorOptions>({
    mode: "color",
    color: { r: 0, g: 0, b: 0 },
    isRainbowPerLetter: false,
    rainbowSpeed: 0,
  });
  const [effectOptions, setEffectOptions] = useState({
    marquee: {
      isForced: false,
      speed: 0,
    },
  });

  useEffect(() => {
    setColorOptions(generateRandomColorOptions());
    setEffectOptions(generateRandomEffectOptions());
  }, []);

  const handleSubmit = useCallback(async () => {
    await entries.add.call({
      text: message,
      options: {
        color:
          colorOptions.mode === "color"
            ? { Rgb: colorOptions.color }
            : {
                Rainbow: {
                  is_per_letter: colorOptions.isRainbowPerLetter,
                  speed: colorOptions.rainbowSpeed,
                },
              },
        marquee: effectOptions.marquee,
      },
    });
    setMessage("");

    await mutate("/entries");
    await mutate("/entries/scroll");
    await mutate("/pause");
  }, [message, colorOptions, effectOptions, mutate]);

  useEffect(() => {
    setEffectOptions((effectOptions) => ({
      ...effectOptions,
      marquee: {
        ...effectOptions.marquee,
        isForced: message.length >= FORCE_ENABLE_MARQUEE_LENGTH,
      },
    }));
  }, [message]);

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center gap-12 p-8">
      <div className="flex w-full flex-col items-center justify-center gap-8">
        <Status />
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-center text-2xl">c&apos;mon, write something</p>
            <p className="text-center text-xs text-zinc-400">
              and maybe sign your name too
            </p>
          </div>
        </div>
        <Message
          message={message}
          onChange={setMessage}
          disabled={!isSubmitable}
          onSubmit={handleSubmit}
        />
      </div>

      <Colors colorOptions={colorOptions} setColorOptions={setColorOptions} />
      <Effects
        effectOptions={effectOptions}
        setEffectOptions={setEffectOptions}
      />
      <Controls isSubmitable={isSubmitable} handleSubmit={handleSubmit} />
      <Divider className="max-w-2xl" />
      <Entries />
    </div>
  );
}
