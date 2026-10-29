import { Inter, JetBrains_Mono } from "next/font/google";

/**
 * Pitline type families (design/DESIGN.md "Type"): Inter everywhere (brand kit, D22), JetBrains Mono
 * for codes and references. Apply `fontVariables` to the element that wraps Pitline UI; the
 * `font-display`, `font-sans` and `font-mono` utilities in globals.css read these variables.
 */
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: "500",
  variable: "--font-jetbrains-mono",
  display: "swap",
  preload: false,
});

export const fontVariables = [inter.variable, jetbrainsMono.variable].join(" ");
