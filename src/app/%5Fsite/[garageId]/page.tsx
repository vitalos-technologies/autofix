import type { Metadata } from "next";
import { requireSiteGarage } from "@/lib/tenancy/garage";

// No title here: the site layout's default ("Book online | <garage name>")
// applies. A page's own title takes the root "| Autofix" template instead,
// because a layout's title template only reaches child segments.
export const metadata: Metadata = {
  description: "Book a diagnostics, repair, service or inspection appointment online.",
};

// Placeholder while the 5-step booking flow (P2.8) is built against the native engine.
export default async function BookPage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  return (
    <section className="mx-auto grid min-h-dvh max-w-xl content-center gap-3 px-5 py-12">
      <h1 className="text-3xl font-extrabold text-[#071127]">{garage.name}</h1>
      <p className="text-base leading-7 text-[#3d4a5c]">Online booking is being set up.</p>
    </section>
  );
}
