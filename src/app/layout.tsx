import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import siteIcon from "../../assets/sobautofix_siteicon.png";
import { VehicleSessionProvider } from "@/components/vehicle/vehicle-context";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "optional", preload: false });
const barlow = Barlow_Condensed({ subsets: ["latin"], weight: "700", variable: "--font-barlow", display: "optional", preload: false });

export const metadata: Metadata = {
  title: { default: "Autofix", template: "%s | Autofix" },
  description: "Online booking and garage management.",
  applicationName: "Autofix",
  // The admin host must never be indexed. Garage booking sites get their own
  // robots rules when they move to /_site (P1.7).
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: siteIcon.src, type: "image/png" }],
    apple: [{ url: siteIcon.src, type: "image/png" }],
  },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#030712" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" data-scroll-behavior="smooth" className={`${inter.variable} ${barlow.variable}`}>
      <body>
        <VehicleSessionProvider>
          <main>{children}</main>
        </VehicleSessionProvider>
      </body>
    </html>
  );
}
