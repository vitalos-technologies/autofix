import { Mail, Phone } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import { ManageBooking } from "@/components/booking/manage-booking";
import { Container } from "@/components/ui/container";
import { formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import { requireSiteGarage } from "@/lib/tenancy/garage";

export const metadata: Metadata = {
  title: "Manage your booking",
  description: "Find, reschedule or cancel your vehicle appointment online.",
  robots: { index: false, follow: false, nocache: true },
};

export default async function ManageBookingPage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  const phoneHref = telHref(garage.phone);
  return (
    <>
      <section className="hero-grid py-10 text-white sm:py-12 lg:py-14">
        <Container className="max-w-6xl">
          <h1 className="text-balance text-4xl leading-[0.95] font-extrabold sm:text-5xl">Manage your booking</h1>
          <p className="mt-4 max-w-2xl leading-7 text-[#C6D2DF]">Need to change your appointment with {garage.name}? Find your booking below to reschedule or cancel it.</p>
        </Container>
      </section>
      <section className="bg-[#F4F7FA] py-8 sm:py-10 lg:py-12">
        <Container className="max-w-6xl">
          <ManageBooking />
          <aside className="mt-8 rounded-3xl bg-[#071127] p-6 text-white sm:p-8">
            <h2 className="text-2xl font-extrabold">Need help with your booking?</h2>
            <p className="mt-3 max-w-3xl leading-7 text-[#C6D2DF]">If your appointment is very close, work has already started, or you are unable to make changes online, please contact {garage.name} directly and we&apos;ll help you.</p>
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
              {phoneHref && <a href={phoneHref} className="inline-flex min-h-11 items-center gap-2 font-bold text-[#67B9FF] hover:text-white"><Phone size={17} aria-hidden="true" /> {formatPhoneForDisplay(garage.phone)}</a>}
              {garage.email && <a href={`mailto:${garage.email}`} className="inline-flex min-h-11 items-center gap-2 font-bold text-[#67B9FF] hover:text-white"><Mail size={17} aria-hidden="true" /> {garage.email}</a>}
            </div>
          </aside>
          <p className="mt-6 text-center text-xs text-[#667586]">Looking to make a new appointment? <Link href="/" className="font-bold text-[#1974E2]">Book online</Link>.</p>
        </Container>
      </section>
    </>
  );
}
