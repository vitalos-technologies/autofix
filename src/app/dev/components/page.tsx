import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fontVariables } from "@/app/fonts";
import { ComponentGallery } from "./component-gallery";

export const metadata: Metadata = {
  title: "Booking components (dev)",
  robots: { index: false, follow: false },
};

/** Dev-only gallery of the booking components. 404 in production unless ENABLE_DEV_COMPONENTS=true. */
export default function DevComponentsPage() {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEV_COMPONENTS !== "true") notFound();
  return (
    <main className={`${fontVariables} font-sans`}>
      <ComponentGallery />
    </main>
  );
}
