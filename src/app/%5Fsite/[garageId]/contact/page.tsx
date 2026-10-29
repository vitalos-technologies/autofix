import type { Metadata } from "next";
import { formatRegistrationDisplay } from "@/components/book";
import { readBookingDraft } from "@/lib/booking-engine/state";
import { humanCheckConfigured } from "@/lib/booking-flow/server";
import { formatPhoneForDisplay } from "@/lib/tenancy/contact";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen } from "../_components/booking-screen";
import { ContactForm } from "../_components/contact-form";

export const metadata: Metadata = { title: "Contact us" };

/**
 * Contact us (Temitope, 29 Oct 2026): a question or a job that doesn't fit the booking steps. It goes to
 * this host's garage as a `general` enquiry (POST /api/enquiries), into its Enquiries tab with the
 * usual email. A car already entered in this browser's booking is offered from the sealed draft cookie,
 * never from the address.
 */
export default async function ContactPage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  const draft = await readBookingDraft(garage.id).catch(() => null);
  const registration = draft?.vehicle?.registration ? formatRegistrationDisplay(draft.vehicle.registration) : "";

  return (
    <BookingScreen garage={garage} subtitle="Contact us" back={{ href: "/", label: "Back to booking" }}>
      <ContactForm
        garageName={garage.name}
        phone={garage.phone}
        phoneDisplay={formatPhoneForDisplay(garage.phone)}
        initialRegistration={registration}
        humanCheck={humanCheckConfigured()}
      />
    </BookingScreen>
  );
}
