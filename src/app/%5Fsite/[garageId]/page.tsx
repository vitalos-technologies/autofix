import type { Metadata } from "next";
import { readBookingSession } from "@/lib/booking-engine/state";
import { needsHumanCheck } from "@/lib/booking-flow/server";
import { garageLocation, requireSiteGarage, type Garage } from "@/lib/tenancy/garage";
import { BookingScreen } from "./_components/booking-screen";
import { VehicleStep } from "./_components/vehicle-step";

// No title here: the site layout's default ("Book online | <garage name>")
// applies. A page's own title takes the root "| Autofix" template instead,
// because a layout's title template only reaches child segments.
export const metadata: Metadata = {
  description: "Book your car in online: enter the registration, choose the work and pick a time.",
};

/** "Doncaster · Diagnostics & repairs": the town and the garage's strap line (once if it repeats the town). */
function headerSubtitle(garage: Garage) {
  const town = garageLocation(garage);
  const tagline = garage.tagline;
  if (tagline && town && tagline.toLowerCase().includes(town.toLowerCase())) return tagline;
  return [town, tagline].filter(Boolean).join(" · ");
}

/** Book 1 · Vehicle. The registration is posted to a server action and kept in the sealed draft only. */
export default async function VehiclePage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  const { draft, meta } = await readBookingSession(garage.id);
  return (
    <BookingScreen garage={garage} step={1} subtitle={headerSubtitle(garage)}>
      <VehicleStep
        motEnabled={garage.motEnabled}
        timeZone={garage.timezone}
        initialVehicle={draft.vehicle ?? null}
        humanCheck={needsHumanCheck(meta)}
      />
    </BookingScreen>
  );
}
