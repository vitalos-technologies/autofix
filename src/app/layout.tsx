import type { Metadata, Viewport } from "next";
import { fontVariables } from "./fonts";
import "./globals.css";

// The app icon is `src/app/icon.svg` (Next.js metadata file convention).
export const metadata: Metadata = {
  title: { default: "Autofix", template: "%s | Autofix" },
  description: "Online booking and garage management.",
  applicationName: "Autofix",
  // The admin host must never be indexed. Garage booking sites set their own
  // robots rules in the /_site layout.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#030712" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" data-scroll-behavior="smooth" className={fontVariables}>
      {/* No main landmark here: the admin shell, the booking site layout and each standalone page render their own. */}
      <body>{children}</body>
    </html>
  );
}
