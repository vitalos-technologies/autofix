import type { MetadataRoute } from "next";

/** Web app manifest: the brand app icon (brand kit, D22), Navy theme. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pitline",
    short_name: "Pitline",
    description: "Online booking, reminders and AI front desk tools for independent garages.",
    start_url: "/app",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0f2747",
    icons: [
      { src: "/brand/pitline-app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/pitline-app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/pitline-app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
