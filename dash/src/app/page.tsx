"use client";

import cx from "classnames";
import { useState, useMemo } from "react";
import { CirclePicker } from "react-color";
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";

import { addEntry, clearEntries } from "@/app/actions";

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

  const [colorMode, setColorMode] = useState("Color");
  const [color, setColor] = useState("ffffff");
  const [isRainbowPerLetter, setIsRainbowPerLetter] = useState(false);
  const [rainbowSpeed, setRainbowSpeed] = useState(5);

  const [marqueeSpeed, setMarqueeSpeed] = useState(5);
  const [twinkleSpeed, setTwinkleSpeed] = useState(5);

  return (
    <div className="h-full p-8 flex flex-col gap-12 justify-center items-center">
      <div className="w-full max-w-2xl flex flex-col gap-8">
        <h1 className="text-4xl text-center">c&apos;mon, write something</h1>
        <form
          className="flex flex-col gap-8 items-center"
          onSubmit={(e) => {
            e.preventDefault();

            if (!isValid) return;

            addEntry({
              text,
              options: {
                color:
                  colorMode === "Color"
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
                  <span className="text-gray-500">Hit enter to submit...</span>
                ) : (
                  <span className="text-gray-500">Use the text box.</span>
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

      <div className="w-full max-w-md flex flex-col gap-4 items-center">
        <div className="w-full border-b border-gray-200">
          <nav className="w-full -mb-px flex">
            {["Color", "Rainbow"].map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setColorMode(tab);
                }}
                className={cx(
                  tab === colorMode
                    ? "border-blue-500 text-blue-600"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700",
                  "w-1/2 border-b-2 py-4 px-1 text-center text-sm font-medium"
                )}
              >
                {tab}
              </button>
            ))}
          </nav>
        </div>
        <div className="h-48 pt-2">
          {colorMode === "Color" ? (
            <div className="flex flex-col gap-4 items-center">
              {/* <h2 className="text-xs text-gray-500">Pick a color, any color</h2> */}
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
          ) : (
            <fieldset className="flex flex-col gap-4">
              <div className="relative flex items-start">
                <div className="flex h-6 items-center">
                  <input
                    name="comments"
                    type="checkbox"
                    checked={isRainbowPerLetter}
                    onChange={(e) => setIsRainbowPerLetter(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                  />
                </div>
                <div className="ml-3 text-sm leading-6">
                  <span className="font-medium text-gray-900">
                    Rainbow per letter
                  </span>{" "}
                  <span className="text-gray-500">
                    makes each letter glow a different color.
                  </span>
                </div>
              </div>
            </fieldset>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 items-center">
        <h2 className="text-xs text-gray-500 border-b border-gray-300 pb-2">
          Make it special
        </h2>
        <fieldset className="flex flex-col gap-4">
          <div className="relative flex items-start">
            <div className="flex h-6 items-center">
              <input
                name="comments"
                type="checkbox"
                checked={marqueeSpeed > 0}
                onChange={(e) => setMarqueeSpeed(e.target.checked ? 5 : 0)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
              />
            </div>
            <div className="ml-3 text-sm leading-6">
              <span className="font-medium text-gray-900">Marquee</span>{" "}
              <span className="text-gray-500">makes it sliiiide over.</span>
            </div>
          </div>
        </fieldset>
      </div>

      <div className="flex flex-col">
        <button
          className="rounded-md flex flex-row gap-2 px-4 py-3 items-center justify-center text-sm font-semibold text-white bg-red-600 hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={() => {
            clearEntries();
          }}
        >
          <TrashIcon className="h-5 w-5" />
          Clear all entries
        </button>
      </div>
    </div>
  );
}
