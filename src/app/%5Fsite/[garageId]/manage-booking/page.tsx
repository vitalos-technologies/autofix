import type { Metadata } from "next";
import { requireSiteGarage } from "@/lib/tenancy/garage";

export const metadata: Metadata = {
  title: "Manage your booking",
  robots: { index: false, follow: false, nocache: true },
};

// Placeholder while the manage booking page (P2.9) is built against the native engine.
export default async function ManageBookingPage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  return (
    <section className="mx-auto grid min-h-dvh max-w-xl content-center gap-3 px-5 py-12">
      <h1 className="text-3xl font-extrabold text-[#071127]">{garage.name}</h1>
      <p className="text-base leading-7 text-[#3d4a5c]">Online booking is being set up.</p>
    </section>
  );
}
