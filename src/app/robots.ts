import type { MetadataRoute } from "next";

// The admin host must not be indexed. Per-garage booking sites will publish
// their own robots rules and sitemaps from /_site (P1.7 and later).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
