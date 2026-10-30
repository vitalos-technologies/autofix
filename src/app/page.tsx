import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";
import { marketing } from "@/lib/marketing/content";
import { adminBaseUrl } from "@/lib/tenancy/urls";

// The admin host's home page is the Pitline marketing page; "Log in" goes to the admin sign-in (/app/login).
// Garage booking sites never reach this route: the proxy rewrites their hosts to /_site.
export const metadata: Metadata = {
  metadataBase: new URL(adminBaseUrl()),
  title: { absolute: marketing.metaTitle },
  description: marketing.description,
  // The rest of the admin host stays noindex (root layout); this page is the public face.
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: marketing.name,
    title: marketing.metaTitle,
    description: marketing.description,
    images: [{ url: "/brand/pitline-og.png", width: 1200, height: 630, alt: "Pitline. Your garage, fully booked." }],
  },
};

export default function HomePage() {
  return <MarketingPage />;
}
