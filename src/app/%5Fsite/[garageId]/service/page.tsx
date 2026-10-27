import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { formatRegistrationDisplay } from "@/components/book";
import { readBookingDraft } from "@/lib/booking-engine/state";
import { loadBookingServices } from "@/lib/booking-flow/server";
import { redirectForStep } from "@/lib/booking-flow/steps";
import { vehicleName } from "@/lib/booking-flow/vehicle";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import type { OnlineService } from "@/lib/booking-engine/types";
import { BookingScreen, BookingUnavailable } from "../_components/booking-screen";
import { ServiceStep } from "../_components/service-step";

export const metadata: Metadata = { title: "Choose a service", robots: { index: false, follow: false } };

/** Book 2 · Service. Needs the car from step 1. */
export default async function ServicePage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  const draft = await readBookingDraft(garage.id);
  const target = redirectForStep("service", draft, null);
  if (target) redirect(target);

  const vehicle = draft.vehicle!;
  const subtitle = [vehicleName(vehicle), formatRegistrationDisplay(vehicle.registration)].filter(Boolean).join(" · ");
  const back = { href: "/", label: "Back to vehicle" };

  let services: OnlineService[];
  try {
    services = await loadBookingServices(garage);
  } catch {
    return (
      <BookingScreen garage={garage} step={2} subtitle={subtitle} back={back} withActionBar={false}>
        <BookingUnavailable garage={garage} />
      </BookingScreen>
    );
  }
  if (services.length === 0) {
    return (
      <BookingScreen garage={garage} step={2} subtitle={subtitle} back={back} withActionBar={false}>
        <BookingUnavailable garage={garage} title="No services can be booked online yet" />
      </BookingScreen>
    );
  }

  return (
    <BookingScreen garage={garage} step={2} subtitle={subtitle} back={back}>
      <ServiceStep
        services={services.map(({ id, name, description, durationMin, pricePence, priceMode, locationMode }) => ({
          id,
          name,
          description,
          durationMin,
          pricePence,
          priceMode,
          locationMode,
        }))}
        initial={{
          serviceId: draft.serviceId,
          locationMode: draft.locationMode,
          postcode: draft.postcode,
          symptoms: draft.symptoms,
          note: draft.note,
        }}
      />
    </BookingScreen>
  );
}
