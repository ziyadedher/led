import { useEffect, useState } from "react";
import { SwatchIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";

import { Checkbox } from "@/components/checkbox";
import { Label, Fieldset } from "@/components/fieldset";
import { Input } from "@/components/input";

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export const rgbToHex = (rgb: RgbColor) => {
  const hex = (c: number) => {
    const hex = c.toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  };

  return `${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
};

export const hexToRgb = (hex: string): RgbColor | null => {
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
    return null;
  }

  const bigint = parseInt(hex, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
};

export const generateRandomColorOptions = (): ColorOptions => ({
  mode: "color",
  color: {
    r: Math.floor(Math.random() * 255),
    g: Math.floor(Math.random() * 255),
    b: Math.floor(Math.random() * 255),
  },
  isRainbowPerLetter: Math.random() > 0.5,
  rainbowSpeed: Math.floor(Math.random() * 25) + 10,
});

export type ColorOptions = {
  mode: "color" | "rainbow";
  color: RgbColor;
  isRainbowPerLetter: boolean;
  rainbowSpeed: number;
};

const Colors = ({
  colorOptions,
  setColorOptions,
}: {
  colorOptions: ColorOptions;
  setColorOptions: (
    options: ColorOptions | ((options: ColorOptions) => ColorOptions),
  ) => void;
}) => {
  const [colorHex, setColorHex] = useState(rgbToHex(colorOptions.color));
  const [activeTab, setActiveTab] = useState<"color" | "rainbow">("color");

  useEffect(() => {
    setColorHex(rgbToHex(colorOptions.color).toUpperCase());
  }, [colorOptions.color]);

  return (
    <div className="flex w-full max-w-2xl flex-col">
      <div className="mb-4 flex w-full flex-row justify-center gap-2 rounded-lg bg-zinc-100 p-1">
        <button
          className={clsx(
            "flex items-center rounded-md px-4 py-2 hover:bg-zinc-200",
            activeTab === "color" && "bg-white shadow",
          )}
          onClick={() => setActiveTab("color")}
        >
          <SwatchIcon className="mr-2 h-5 w-5" />
          Color
        </button>
        <button
          className={clsx(
            "flex items-center rounded-md px-4 py-2 hover:bg-zinc-200",
            activeTab === "rainbow" && "bg-white shadow",
          )}
          onClick={() => setActiveTab("rainbow")}
        >
          <RectangleStackIcon className="mr-2 h-5 w-5" />
          Rainbow
        </button>
      </div>
      {activeTab === "color" && (
        <div className="flex h-64 flex-col items-center gap-4">
          <div className="grid grid-cols-6 gap-2 rounded-lg bg-zinc-100 p-4">
            {[
              "#FF0000",
              "#FF4500",
              "#FFA500",
              "#FFD700",
              "#FFFF00",
              "#ADFF2F",
              "#00FF00",
              "#00FA9A",
              "#00FFFF",
              "#1E90FF",
              "#0000FF",
              "#8A2BE2",
              "#FF00FF",
              "#FF69B4",
              "#FFC0CB",
              "#FFB6C1",
              "#F0E68C",
              "#E6E6FA",
              "#87CEEB",
              "#40E0D0",
              "#98FB98",
              "#DDA0DD",
              "#D3D3D3",
              "#FFFFFF",
            ].map((color) => (
              <button
                key={color}
                className="h-8 w-8 rounded-full shadow-sm hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                style={{ backgroundColor: color }}
                onClick={() => {
                  const rgb = hexToRgb(color);
                  if (rgb) {
                    setColorOptions((prev) => ({
                      ...prev,
                      mode: "color",
                      color: rgb,
                    }));
                  }
                }}
              />
            ))}
          </div>
          <div className="relative mt-2 overflow-hidden rounded-md bg-white shadow-sm">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center bg-gray-100 p-3">
              <span className="text-md text-gray-400">#</span>
            </div>
            <input
              type="text"
              value={colorHex}
              onChange={(e) => {
                setColorOptions((colorOptions) => {
                  let color = hexToRgb(e.target.value);
                  if (color === null) {
                    return colorOptions;
                  }

                  return {
                    ...colorOptions,
                    mode: "color",
                    color,
                  };
                });
              }}
              className="relative z-10 block w-full rounded-md border-0 bg-transparent px-12 py-1.5 text-sm leading-6 text-gray-900 ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600"
              placeholder="ffffff"
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 flex items-center p-4"
              style={{ backgroundColor: `#${rgbToHex(colorOptions.color)}` }}
            />
          </div>
        </div>
      )}
      {activeTab === "rainbow" && (
        <Fieldset className="flex h-64 flex-col items-center gap-4">
          <div className="flex flex-row items-center gap-4">
            <div className="flex flex-col gap-1">
              <Input
                id="rainbow-speed"
                type="range"
                min={1}
                max={50}
                value={colorOptions.rainbowSpeed}
                onChange={(e) => {
                  setColorOptions((colorOptions) => ({
                    ...colorOptions,
                    mode: "rainbow",
                    rainbowSpeed: Number(e.target.value),
                  }));
                }}
              />
              <Label
                htmlFor="rainbow-speed"
                className="flex w-full flex-row justify-between"
              >
                <span className="text-xs text-zinc-400">Slow</span>
                <span className="text-xs text-zinc-400">
                  {colorOptions.rainbowSpeed}
                </span>
                <span className="text-xs text-zinc-400">Fast</span>
              </Label>
            </div>
          </div>
          <div className="flex flex-row items-center gap-2">
            <Checkbox
              id="rainbow-per-letter"
              checked={colorOptions.isRainbowPerLetter}
              onChange={(isChecked) => {
                setColorOptions((colorOptions) => ({
                  ...colorOptions,
                  mode: "rainbow",
                  isRainbowPerLetter: isChecked,
                }));
              }}
              className="cursor-pointer"
            />
            <Label
              htmlFor="rainbow-per-letter"
              className="flex cursor-pointer flex-row items-center gap-2"
            >
              <span className="font-medium text-gray-900">
                Rainbow per letter
              </span>{" "}
              <span className="text-xs text-zinc-400">
                makes each letter glow a different color.
              </span>
            </Label>
          </div>
        </Fieldset>
      )}
    </div>
  );
};

export default Colors;
