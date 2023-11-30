import { Checkbox, Label, Tabs } from "flowbite-react";
import { CirclePicker, RGBColor } from "react-color";
import { HiSwatch } from "react-icons/hi2";
import { PiRainbowBold } from "react-icons/pi";

export const rgbToHex = (rgb: RGBColor) => {
  const hex = (c: number) => {
    const hex = c.toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  };

  return `${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
};

export const hexToRgb = (hex: string): RGBColor => {
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
  color: RGBColor;
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
}) => (
  <Tabs.Group style="underline" className="w-full max-w-lg justify-center">
    <Tabs.Item active title="Color" icon={HiSwatch}>
      <div className="flex flex-col items-center gap-4">
        <p className="text-sm text-gray-400">
          you&apos;ve chosen to select a specific color for the text
        </p>
        <div className="relative mt-2 overflow-hidden rounded-md bg-white shadow-sm">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center bg-gray-100 p-3">
            <span className="text-md text-gray-400">#</span>
          </div>
          <input
            type="text"
            name="price"
            value={rgbToHex(colorOptions.color)}
            onChange={(e) =>
              setColorOptions((colorOptions) => ({
                ...colorOptions,
                mode: "color",
                color: hexToRgb(e.target.value),
              }))
            }
            className="relative z-10 block w-full rounded-md border-0 bg-transparent px-12 py-1.5 text-sm leading-6 text-gray-900 ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600"
            placeholder="ffffff"
          />
          <div
            className="pointer-events-none absolute inset-y-0 right-0 flex items-center p-4"
            style={{ backgroundColor: `#${rgbToHex(colorOptions.color)}` }}
          />
        </div>
        <CirclePicker
          color={colorOptions.color}
          onChange={(c) => {
            setColorOptions((colorOptions) => ({
              ...colorOptions,
              mode: "color",
              color: c.rgb,
            }));
          }}
        />
      </div>
    </Tabs.Item>
    <Tabs.Item title="Rainbow" icon={PiRainbowBold}>
      <fieldset className="flex flex-col items-center gap-4">
        <p className="text-sm text-gray-400">
          you&apos;ve chosen to make the text rainbow
        </p>
        <div className="flex flex-row items-center gap-4">
          <Label htmlFor="rainbow-speed">Rainbow Speed</Label>
          <div className="flex flex-col">
            <input
              id="rainbow-speed"
              type="range"
              min="1"
              max="50"
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
              className="flex w-full flex-row justify-between text-xs font-light text-gray-500"
            >
              <span>Slow</span>
              <span>Fast</span>
            </Label>
          </div>
        </div>
        <div className="flex flex-row items-center gap-2">
          <Checkbox
            id="rainbow-per-letter"
            checked={colorOptions.isRainbowPerLetter}
            onChange={(e) => {
              setColorOptions((colorOptions) => ({
                ...colorOptions,
                mode: "rainbow",
                isRainbowPerLetter: e.target.checked,
              }));
            }}
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
);

export default Colors;
