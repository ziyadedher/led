"use client";

import cx from "classnames";
import { Button, Checkbox, Label, Tabs, Tooltip } from "flowbite-react";
import { useState, useMemo, useEffect } from "react";
import { CirclePicker } from "react-color";
import { HiSwatch } from "react-icons/hi2";
import { PiRainbowBold } from "react-icons/pi";
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";

import { addEntry, clearEntries } from "@/app/actions";

const SHORT_LENGTH = 12;
const MAX_LENGTH = 64;

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
  const [text, setText] = useState("");
  const isValid = useMemo(() => text.length <= MAX_LENGTH, [text]);
  const isSubmitable = useMemo(
    () => isValid && text.length > 0,
    [isValid, text]
  );
  const isLong = useMemo(() => text.length > SHORT_LENGTH, [text]);
  useEffect(() => {
    if (isLong) {
      setMarqueeSpeed(5);
    }
  }, [isLong]);

  const [colorMode, setColorMode] = useState(0);
  const [color, setColor] = useState("ffffff");
  const [isRainbowPerLetter, setIsRainbowPerLetter] = useState(false);
  const [rainbowSpeed, setRainbowSpeed] = useState(5);

  const [marqueeSpeed, setMarqueeSpeed] = useState(5);

  return (
    <div className="relative h-full p-8 flex flex-col gap-12 justify-center items-center">
      <div className="w-full max-w-2xl flex flex-col gap-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-4xl text-center">c&apos;mon, write something</h1>
          <h2 className="text-xs text-center text-gray-400">
            and maybe sign your name too
          </h2>
        </div>
        <form
          className="flex flex-col gap-8 items-center"
          onSubmit={(e) => {
            e.preventDefault();

            if (!isValid) return;

            addEntry({
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
          }}
        >
          <div className="w-full flex flex-col gap-3 items-center">
            <div className="w-full flex flex-row">
              <div className="relative w-full">
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className={cx(
                    "block w-full h-12 rounded-l-md border-0 pr-10 py-1.5 ring-inset ring-1 text-sm leading-6 focus:ring-2 focus:ring-inset",
                    isValid
                      ? isSubmitable
                        ? "text-gray-900 ring-gray-200 placeholder:text-gray-400 focus:ring-green-600"
                        : "text-gray-900 ring-gray-200 placeholder:text-gray-400 focus:ring-gray-300"
                      : "text-red-900 ring-red-300 placeholder:text-red-300 focus:ring-red-500"
                  )}
                  placeholder="your cool message"
                />
                <div
                  className={cx(
                    "pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3",
                    isValid ? "invisible" : "visible"
                  )}
                >
                  <ExclamationCircleIcon className="h-5 w-5 text-red-500" />
                </div>
              </div>
              <button
                type="submit"
                disabled={!isSubmitable}
                className={cx(
                  "rounded-r-md px-3 py-2 text-sm font-semibold text-white shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                  isValid
                    ? isSubmitable
                      ? "bg-green-600 hover:bg-green-500 focus-visible:outline-green-600"
                      : "bg-gray-200"
                    : "bg-red-600"
                )}
              >
                <CheckCircleIcon className="h-5 w-5" />
              </button>
            </div>
            <p className="text-xs">
              {isValid ? (
                isSubmitable ? (
                  <span className="text-gray-400">Hit enter to submit...</span>
                ) : (
                  <span className="text-gray-400">Use the text box.</span>
                )
              ) : (
                <span className="text-red-500">
                  Let&apos;s keep it under {MAX_LENGTH} characters, eh?
                </span>
              )}
            </p>
          </div>
        </form>
      </div>

      <Tabs.Group
        onActiveTabChange={(tab) => setColorMode(tab)}
        style="underline"
        className="w-full max-w-lg justify-center"
      >
        <Tabs.Item active title="Color" icon={HiSwatch}>
          <div className="h-48 flex flex-col gap-4 items-center">
            <div className="relative mt-2 rounded-md shadow-sm bg-white overflow-hidden">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center p-3 bg-gray-100">
                <span className="text-md text-gray-400">#</span>
              </div>
              <input
                type="text"
                name="price"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="block relative z-10 w-full rounded-md border-0 py-1.5 px-12 bg-transparent text-sm leading-6 text-gray-900 ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600"
                placeholder="ffffff"
              />
              <div
                className="pointer-events-none absolute inset-y-0 right-0 flex p-4 items-center"
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
          <fieldset className="h-48 flex flex-col gap-4">
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

      <div className="flex flex-col gap-4 items-center">
        <h2 className="text-xs text-gray-500 border-b border-gray-300 pb-2">
          Make it special
        </h2>
        <fieldset className="flex flex-col gap-4">
          <Tooltip
            content={`Marquee is force-enabled when the text is longer than ${SHORT_LENGTH} characters.`}
          >
            <div className="flex flex-row items-center gap-2">
              <Checkbox
                id="marquee"
                disabled={isLong}
                checked={marqueeSpeed > 0}
                onChange={(e) => setMarqueeSpeed(e.target.checked ? 5 : 0)}
                className={cx(isLong ? "cursor-not-allowed" : "cursor-pointer")}
              />
              <Label
                htmlFor="marquee"
                disabled={isLong}
                className={cx(isLong ? "cursor-not-allowed" : "cursor-pointer")}
              >
                <span className="font-medium text-gray-900">Marquee</span>{" "}
                <span className="text-gray-500">makes it sliiiide over.</span>
              </Label>
            </div>
          </Tooltip>
        </fieldset>
      </div>

      <div className="flex flex-col">
        <Button
          color="failure"
          onClick={() => {
            clearEntries();
          }}
        >
          <TrashIcon className="mr-2 h-5 w-5" />
          Clear all entries
        </Button>
      </div>
    </div>
  );
}
