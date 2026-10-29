import { describe, expect, it } from "vitest";
import {
  ACCENT_PALETTE,
  BOOKING_BACKGROUND,
  DEFAULT_ACCENT,
  accentForWhiteText,
  bookingAccent,
  contrastRatio,
  garageAccentStyle,
  normaliseAccent,
} from "@/lib/branding/accent";

describe("normaliseAccent", () => {
  it("returns lower-case #rrggbb for 3- and 6-digit hex colours", () => {
    expect(normaliseAccent("#155FBA")).toBe("#155fba");
    expect(normaliseAccent("155fba")).toBe("#155fba");
    expect(normaliseAccent(" #abc ")).toBe("#aabbcc");
  });

  it("rejects anything that is not a hex colour", () => {
    expect(normaliseAccent("blue")).toBeNull();
    expect(normaliseAccent("#12345")).toBeNull();
    expect(normaliseAccent("url(javascript:alert(1))")).toBeNull();
    expect(normaliseAccent("")).toBeNull();
    expect(normaliseAccent(null)).toBeNull();
    expect(normaliseAccent(undefined)).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#64748b", "#ffffff")).toBeCloseTo(4.76, 1);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#155fba", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#155fba"), 10);
  });

  it("throws on an invalid colour", () => {
    expect(() => contrastRatio("nope", "#ffffff")).toThrow(TypeError);
  });
});

describe("accentForWhiteText", () => {
  it.each(ACCENT_PALETTE)("keeps palette colour %s unchanged", (colour) => {
    expect(contrastRatio(colour, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(accentForWhiteText(colour)).toBe(colour);
  });

  it("darkens #ffcc00 until white text on it reaches 4.5:1", () => {
    const darkened = accentForWhiteText("#ffcc00");
    expect(darkened).not.toBe("#ffcc00");
    expect(darkened).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(darkened, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // Only as dark as needed: still a recognisable colour, not black.
    expect(contrastRatio(darkened, "#ffffff")).toBeLessThan(5);
    expect(darkened).not.toBe("#000000");
  });

  it("darkens other light colours, including greys", () => {
    for (const colour of ["#ffffff", "#7dd3fc", "#22c55e", "#999999"]) {
      expect(contrastRatio(accentForWhiteText(colour), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("falls back to the default accent for invalid input", () => {
    expect(accentForWhiteText("not-a-colour")).toBe(DEFAULT_ACCENT);
    expect(accentForWhiteText(null)).toBe(DEFAULT_ACCENT);
  });
});

describe("bookingAccent and garageAccentStyle", () => {
  it.each(ACCENT_PALETTE)("keeps palette colour %s unchanged on booking pages", (colour) => {
    expect(bookingAccent(colour)).toBe(colour);
    expect(contrastRatio(colour, BOOKING_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it("makes custom colours readable on white and on the grey page background", () => {
    const accent = bookingAccent("#ffcc00");
    expect(contrastRatio(accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accent, BOOKING_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it("returns CSS custom properties for a style prop", () => {
    expect(garageAccentStyle("#0F766E")).toEqual({ "--garage-accent": "#0f766e", "--garage-accent-ink": "#fff" });
    expect(garageAccentStyle(undefined)).toEqual({ "--garage-accent": DEFAULT_ACCENT, "--garage-accent-ink": "#fff" });
    const custom = garageAccentStyle("#ffcc00");
    expect(contrastRatio(custom["--garage-accent"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
