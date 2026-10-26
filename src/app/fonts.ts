import { Barlow_Condensed, Inter, JetBrains_Mono } from "next/font/google";

/**
 * Autofix type families (design/DESIGN.md "Type"). Apply `fontVariables` to the
 * element that wraps Autofix UI; the `font-display`, `font-sans` and `font-mono`
 * utilities in globals.css read these variables.
 */
export const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

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

export const fontVariables = [barlowCondensed.variable, inter.variable, jetbrainsMono.variable].join(" ");
