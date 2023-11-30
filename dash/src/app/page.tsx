"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useSWRConfig } from "swr";

import Text from "@/app/components/text";
import Colors, { generateRandomColorOptions } from "@/app/components/colors";
import Controls from "@/app/components/controls";
import Effects, {
  generateRandomEffectOptions,
  FORCE_ENABLE_MARQUEE_LENGTH,
} from "@/app/components/effects";
import Entries from "@/app/components/entries";
import { entries } from "@/utils/actions";

export default function RootPage() {
  const { mutate } = useSWRConfig();

  const [text, setText] = useState("");
  const isSubmitable = useMemo(() => text.length > 0, [text]);

  const [colorOptions, setColorOptions] = useState(generateRandomColorOptions);
  const [effectOptions, setEffectOptions] = useState(
    generateRandomEffectOptions,
  );

  const handleSubmit = useCallback(async () => {
    await entries.add.call({
      text,
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
    setText("");

    await mutate("/entries");
    await mutate("/entries/scroll");
    await mutate("/pause");
  }, [text, colorOptions, effectOptions, mutate]);

  useEffect(() => {
    if (text.length >= FORCE_ENABLE_MARQUEE_LENGTH) {
      setEffectOptions((effectOptions) => ({
        ...effectOptions,
        marquee: {
          ...effectOptions.marquee,
          isForced: true,
        },
      }));
    }
  }, [text, effectOptions]);

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center gap-12 p-8">
      <Text
        text={text}
        onChange={setText}
        disabled={!isSubmitable}
        onSubmit={handleSubmit}
      />

      <Colors colorOptions={colorOptions} setColorOptions={setColorOptions} />
      <Effects
        effectOptions={effectOptions}
        setEffectOptions={setEffectOptions}
      />
      <Controls isSubmitable={isSubmitable} handleSubmit={handleSubmit} />

      <Entries />
    </div>
  );
}
