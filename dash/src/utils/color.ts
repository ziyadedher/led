/** Tiny rgb↔hex helpers shared across mode composers + ColorPicker. */

export type Rgb = { r: number; g: number; b: number };

/** The hardware's signature LED-orange — the one brand color. */
export const LED_ORANGE: Rgb = { r: 255, g: 138, b: 44 };

/** Clamp+round an arbitrary number to a 0-255 channel value. */
export const clampChannel = (v: number): number =>
  Math.max(0, Math.min(255, Math.round(v)));

/**
 * Coerce an untrusted persisted value into an Rgb, falling back per
 * channel. Used by the mode-config parsers, which read JSON that may
 * be partial or malformed.
 */
export function parseRgb(raw: unknown, fallback: Rgb): Rgb {
  if (typeof raw !== "object" || raw === null) return { ...fallback };
  const o = raw as Record<string, unknown>;
  const ch = (v: unknown, f: number) =>
    typeof v === "number" && Number.isFinite(v) ? clampChannel(v) : f;
  return { r: ch(o.r, fallback.r), g: ch(o.g, fallback.g), b: ch(o.b, fallback.b) };
}

export const rgbToHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b]
    .map((v) => clampChannel(v).toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;

export function hexToRgb(hex: string): Rgb | null {
  const cleaned = hex.replace(/^#/, "");
  const value = cleaned.length === 3 ? cleaned.replace(/./g, "$&$&") : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
