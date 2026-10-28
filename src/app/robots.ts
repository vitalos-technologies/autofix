import type { MetadataRoute } from "next";

// Admin host: only the marketing page (/) may be crawled; the admin, sign-up, auth and API never.
// The longer, more specific "/$" rule wins over "/" for crawlers that follow RFC 9309.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/$", disallow: "/" } };
}
