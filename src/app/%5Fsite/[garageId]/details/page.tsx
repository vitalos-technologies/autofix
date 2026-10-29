import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BookingSummaryBar } from "@/components/book";
import type { OnlineService } from "@/lib/booking-engine/types";
import { readBookingSession } from "@/lib/booking-engine/state";
import { LOCATION_LABELS } from "@/lib/booking-flow/copy";
import { loadBookingServices, needsHumanCheck } from "@/lib/booking-flow/server";
import { redirectForStep } from "@/lib/booking-flow/steps";
import { getBookingExtrasOptions } from "@/lib/courtesy/booking-site";
import { formatPounds } from "@/lib/payments/amounts";
import { depositQuote } from "@/lib/payments/server";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen, BookingUnavailable } from "../_components/booking-screen";
import { DetailsStep } from "../_components/details-step";

export const metadata: Metadata = { title: "Your details", robots: { index: false, follow: false } };

/** Book 4 · Details. Needs the car, service and time; Confirm booking creates the booking. */
export default async function DetailsPage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  const { draft, meta } = await readBookingSession(garage.id);
  const early = redirectForStep("details", draft, null);
  if (early === "/" || early === "/service") redirect(early);

  const back = { href: "/time", label: "Back to time" };
  let services: OnlineService[];
  try {
    services = await loadBookingServices(garage);
  } catch {
    return (
      <BookingScreen garage={garage} step={4} subtitle="Almost done" back={back} withActionBar={false}>
        <BookingUnavailable garage={garage} />
      </BookingScreen>
    );
  }
  const target = redirectForStep("details", draft, services);
  if (target) redirect(target);
  const service = services.find((item) => item.id === draft.serviceId)!;
  const extras = await getBookingExtrasOptions(garage, {
    serviceId: service.id,
    startsAt: draft.startsAt!,
    durationMin: service.durationMin,
    locationMode: draft.locationMode ?? "workshop",
  });
  const deposit = await depositQuote(garage, service.id);

  return (
    <BookingScreen garage={garage} step={4} subtitle="Almost done" back={back}>
      <DetailsStep
        summary={
          <BookingSummaryBar
            registration={draft.vehicle!.registration}
            service={service.name}
            mode={LOCATION_LABELS[draft.locationMode!]}
            start={draft.startsAt!}
            timeZone={garage.timezone}
            editHref="/time"
            editLabel="Edit the time"
          />
        }
        motEnabled={garage.motEnabled}
        garageName={garage.name}
        needsApproval={service.needsApproval || garage.approveOnline}
        humanCheck={needsHumanCheck(meta)}
        extras={extras}
        deposit={deposit ? { amount: formatPounds(deposit.amountPence), holdMin: deposit.holdMin } : null}
      />
    </BookingScreen>
  );
}
