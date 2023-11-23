"use client";

import cx from "classnames";
import { Checkbox, Label, Tabs, Tooltip } from "flowbite-react";
import { useState, useMemo, useEffect, useCallback } from "react";
import { CirclePicker } from "react-color";
import { HiSwatch } from "react-icons/hi2";
import { PiRainbowBold } from "react-icons/pi";
import { useSWRConfig } from "swr";

import Box from "@/app/box";
import Controls from "@/app/controls";
import Entries from "@/app/entries";
import { entries } from "@/utils/actions";

const SHORT_LENGTH = 12;

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  if (hex.startsWith("#")) {
    hex = hex.slice(1);
  }

  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((char) => char + char)
      .join("");
  }

  if (hex.length !== 6) {
    throw new Error("Invalid color");
  }

  const bigint = parseInt(hex, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
};

export default function RootPage() {
  const { mutate } = useSWRConfig();

  const [text, setText] = useState("");
  const isSubmitable = useMemo(() => text.length > 0, [text]);
  const isLong = useMemo(() => text.length > SHORT_LENGTH, [text]);
  useEffect(() => {
    if (isLong) {
      setMarqueeSpeed(5);
    }
  }, [isLong]);

  const [colorMode, setColorMode] = useState(0);
  const [color, setColor] = useState("ffffff");
  const [isRainbowPerLetter, setIsRainbowPerLetter] = useState(false);
  const [rainbowSpeed, setRainbowSpeed] = useState(10);

  const [marqueeSpeed, setMarqueeSpeed] = useState(5);

  const handleSubmit = useCallback(async () => {
    await entries.add.call({
      text,
      options: {
        color:
          colorMode === 0
            ? { Rgb: hexToRgb(color) }
            : {
                Rainbow: {
                  is_per_letter: isRainbowPerLetter,
                  speed: rainbowSpeed,
                },
              },
        marquee: { speed: marqueeSpeed },
      },
    });
    setText("");

    mutate("/entries");
    mutate("/entries/scroll");
    mutate("/pause");
  }, [
    text,
    color,
    colorMode,
    isRainbowPerLetter,
    rainbowSpeed,
    marqueeSpeed,
    mutate,
  ]);

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center gap-12 p-8">
      <Box
        text={text}
        onChange={setText}
        disabled={!isSubmitable}
        onSubmit={handleSubmit}
      />

      <Tabs.Group
        onActiveTabChange={(tab) => setColorMode(tab)}
        style="underline"
        className="w-full max-w-lg justify-center"
      >
        <Tabs.Item active title="Color" icon={HiSwatch}>
          <div className="flex flex-col items-center gap-4">
            <div className="relative mt-2 overflow-hidden rounded-md bg-white shadow-sm">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center bg-gray-100 p-3">
                <span className="text-md text-gray-400">#</span>
              </div>
              <input
                type="text"
                name="price"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="relative z-10 block w-full rounded-md border-0 bg-transparent px-12 py-1.5 text-sm leading-6 text-gray-900 ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600"
                placeholder="ffffff"
              />
              <div
                className="pointer-events-none absolute inset-y-0 right-0 flex items-center p-4"
                style={{ backgroundColor: `#${color}` }}
              />
            </div>
            <CirclePicker
              color={color}
              onChange={(c) => {
                setColor(c.hex.slice(1));
              }}
            />
          </div>
        </Tabs.Item>
        <Tabs.Item title="Rainbow" icon={PiRainbowBold}>
          <fieldset className="flex flex-col items-center gap-4">
            <div className="flex flex-row items-center gap-2">
              <Label htmlFor="rainbow-speed" className="text-gray-500">
                Slow
              </Label>
              <input
                id="rainbow-speed"
                type="range"
                min="1"
                max="50"
                value={rainbowSpeed}
                onChange={(e) => setRainbowSpeed(Number(e.target.value))}
              />
              <Label htmlFor="rainbow-speed" className="text-gray-500">
                Fast
              </Label>
            </div>
            <div className="flex flex-row items-center gap-2">
              <Checkbox
                id="rainbow-per-letter"
                checked={isRainbowPerLetter}
                onChange={(e) => setIsRainbowPerLetter(e.target.checked)}
                className="cursor-pointer"
              />
              <Label htmlFor="rainbow-per-letter" className="cursor-pointer">
                <span className="font-medium text-gray-900">
                  Rainbow per letter
                </span>{" "}
                <span className="text-gray-500">
                  makes each letter glow a different color.
                </span>
              </Label>
            </div>
          </fieldset>
        </Tabs.Item>
      </Tabs.Group>

      <div className="flex max-w-lg flex-col items-center gap-4">
        <h2 className="border-b border-gray-300 pb-2 text-xs text-gray-500">
          Make it special
        </h2>
        <fieldset className="flex flex-col items-center gap-4">
          <div className="flex flex-col items-center gap-2">
            <Tooltip
              content={`Marquee is force-enabled when the text is longer than ${SHORT_LENGTH} characters.`}
            >
              <div className="flex flex-row items-center gap-2">
                <Checkbox
                  id="marquee"
                  disabled={isLong}
                  checked={marqueeSpeed > 0}
                  onChange={(e) => setMarqueeSpeed(e.target.checked ? 5 : 0)}
                  className={cx(
                    isLong ? "cursor-not-allowed" : "cursor-pointer",
                  )}
                />
                <Label
                  htmlFor="marquee"
                  disabled={isLong}
                  className={cx(
                    isLong ? "cursor-not-allowed" : "cursor-pointer",
                  )}
                >
                  <span className="font-medium text-gray-900">Marquee</span>{" "}
                  <span className="text-gray-500">makes it sliiiide over.</span>
                </Label>
              </div>
            </Tooltip>
            {marqueeSpeed > 0 ? (
              <div className="flex flex-row items-center gap-2">
                <Label htmlFor="marquee-speed" className="text-gray-500">
                  Slow
                </Label>
                <input
                  id="marquee-speed"
                  type="range"
                  min="1"
                  max="15"
                  value={marqueeSpeed}
                  onChange={(e) => setMarqueeSpeed(Number(e.target.value))}
                />
                <Label htmlFor="marquee-speed" className="text-gray-500">
                  Fast
                </Label>
              </div>
            ) : null}
          </div>
        </fieldset>
      </div>

      <Controls isSubmitable={isSubmitable} handleSubmit={handleSubmit} />

      <Entries />
    </div>
  );
}
