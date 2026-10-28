import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.PLAYWRIGHT_LOCAL_INVOICING === "true" ? ".next/invoice-tests" : ".next",
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  reactStrictMode: true,
  // Blocking metadata for every user agent (node_modules/next/dist/docs: htmlLimitedBots, "Disabling").
  // The garage layout's title comes from an async generateMetadata; streamed, the <title> lands in
  // <body> after the first paint, so a document (and screen readers, axe) can briefly have none.
  htmlLimitedBots: /.*/,
  experimental: {
    inlineCss: true,
    serverActions: {
      bodySizeLimit: "36mb",
    },
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  // X-Frame-Options and Content-Security-Policy depend on the host (a garage may let its own website
  // frame its booking pages), so `src/proxy.ts` sets them: src/lib/booking-page/security-headers.ts.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
        ],
      },
      // Links that carry a token in their URL. Their route handlers set a stricter Referrer-Policy, but a
      // header from this file replaces the handler's own, so the rule above would win; the last matching rule
      // wins here, so these restate it (DECISIONS A188, checked through the server by tests/e2e/smoke.spec.ts).
      ...["/r/:token", "/c/:token", "/hc/:token", "/manage/link", "/manage-booking", "/signup/invite/:token"].map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
      // The email confirmation page: its form POST still needs an Origin header (src/app/auth/confirm/route.ts).
      { source: "/auth/confirm", headers: [{ key: "Referrer-Policy", value: "strict-origin" }] },
    ];
  },
};

export default nextConfig;
