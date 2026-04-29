/** Tiny rgb↔hex helpers shared across mode composers + ColorPicker. */

export type Rgb = { r: number; g: number; b: number };

export const rgbToHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b]
    .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;

export function hexToRgb(hex: string): Rgb | null {
  const cleaned = hex.replace(/^#/, "");
  const value = cleaned.length === 3 ? cleaned.replace(/./g, "$&$&") : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
