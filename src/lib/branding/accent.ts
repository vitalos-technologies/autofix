import type { CSSProperties } from "react";

/** Default garage accent (design/tokens.css `--garage-accent`). */
export const DEFAULT_ACCENT = "#155fba";

/** Accent options offered in Branding (design/DESIGN.md "Colour"). */
export const ACCENT_PALETTE = ["#155fba", "#0f766e", "#b9451a", "#6d28d9"] as const;

/** WCAG AA contrast for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** Booking page background (`--grey-50`): accent links and chips sit on it as well as on white. */
export const BOOKING_BACKGROUND = "#f4f7fa";

const WHITE = "#ffffff";
const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

type Rgb = readonly [number, number, number];
type Hsl = readonly [number, number, number];

/**
 * Returns the colour as lower-case `#rrggbb`, or `null` when it is not a 3- or 6-digit hex colour.
 * Accepts an optional leading `#` and surrounding whitespace.
 */
export function normaliseAccent(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const match = HEX_PATTERN.exec(input.trim());
  if (!match?.[1]) return null;
  const digits = match[1].toLowerCase();
  const full = digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits;
  return `#${full}`;
}

function toRgb(hex: string): Rgb {
  const normalised = normaliseAccent(hex);
  if (!normalised) throw new TypeError(`Not a hex colour: ${JSON.stringify(hex)}`);
  return [1, 3, 5].map((start) => Number.parseInt(normalised.slice(start, start + 2), 16)) as unknown as Rgb;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two hex colours, from 1 to 21. Throws on an invalid colour. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function hueToChannel(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

function hslToRgb([hue, saturation, lightness]: Hsl): Rgb {
  if (saturation === 0) return [lightness * 255, lightness * 255, lightness * 255];
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hueToChannel(p, q, hue + 1 / 3) * 255, hueToChannel(p, q, hue) * 255, hueToChannel(p, q, hue - 1 / 3) * 255];
}

/**
 * Darkens `hex` (keeping its hue and saturation) until it reaches `minRatio` against every colour in
 * `against`. Colours that already pass are returned unchanged (normalised).
 */
function darkenUntilReadable(hex: string, against: readonly string[], minRatio: number): string {
  const start = normaliseAccent(hex);
  if (!start) throw new TypeError(`Not a hex colour: ${JSON.stringify(hex)}`);
  const passes = (candidate: string) => against.every((other) => contrastRatio(candidate, other) >= minRatio);
  if (passes(start)) return start;

  const [hue, saturation, lightness] = rgbToHsl(toRgb(start));
  for (let step = Math.floor(lightness * 1000) - 1; step >= 0; step -= 1) {
    const candidate = toHex(hslToRgb([hue, saturation, step / 1000]));
    if (passes(candidate)) return candidate;
  }
  return "#000000";
}

/**
 * The garage colour to use behind white text: unchanged when white text on it already reaches 4.5:1,
 * otherwise darkened until it does (design/DESIGN.md: "darken automatically if not").
 * Invalid input falls back to the default accent.
 */
export function accentForWhiteText(hex: string | null | undefined, minRatio = MIN_TEXT_CONTRAST): string {
  const normalised = normaliseAccent(hex);
  if (!normalised) return DEFAULT_ACCENT;
  return darkenUntilReadable(normalised, [WHITE], minRatio);
}

/**
 * The garage colour for booking pages. The accent is used both behind white text (buttons, selected
 * slots) and as text on white and `--grey-50` (links, selected chips), so it must reach 4.5:1 against
 * all three. The four palette colours pass unchanged.
 */
export function bookingAccent(hex: string | null | undefined): string {
  const normalised = normaliseAccent(hex);
  if (!normalised) return DEFAULT_ACCENT;
  return darkenUntilReadable(normalised, [WHITE, BOOKING_BACKGROUND], MIN_TEXT_CONTRAST);
}

export type GarageAccentStyle = CSSProperties & {
  "--garage-accent": string;
  "--garage-accent-ink": string;
};

/**
 * Style prop that sets the garage colour for everything inside, e.g.
 * `<div style={garageAccentStyle(garage.accent)}>`. Unreadable colours are darkened; invalid ones use
 * the default accent.
 */
export function garageAccentStyle(accent: string | null | undefined): GarageAccentStyle {
  return {
    "--garage-accent": bookingAccent(accent),
    "--garage-accent-ink": "#fff",
  };
}
