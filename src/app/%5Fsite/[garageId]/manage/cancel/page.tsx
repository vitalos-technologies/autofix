import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BookingSummaryBar } from "@/components/book";
import { LOCATION_LABELS } from "@/lib/booking-flow/copy";
import { readManagedBooking, toManageBookingView } from "@/lib/booking-flow/manage-server";
import { canChangeOnline } from "@/lib/booking-flow/manage-view";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen } from "../../_components/booking-screen";
import { ManageCancel } from "../../_components/manage-cancel";

export const metadata: Metadata = { title: "Cancel your booking", robots: { index: false, follow: false, nocache: true } };

/** The confirm step before cancelling. Only for bookings that can still be changed online. */
export default async function CancelPage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  const session = await readManagedBooking(garage.id);
  if (session.kind !== "open") redirect("/manage");
  const booking = session.booking;
  if (!canChangeOnline(toManageBookingView(booking).state)) redirect("/manage");

  return (
    <BookingScreen garage={garage} subtitle="Manage your booking" back={{ href: "/manage", label: "Back to your booking" }}>
      <ManageCancel
        garageName={garage.name}
        summary={
          <BookingSummaryBar
            registration={booking.vehicle.registration}
            service={booking.service.name}
            mode={LOCATION_LABELS[booking.locationMode]}
            start={booking.startsAt}
            timeZone={garage.timezone}
          />
        }
      />
    </BookingScreen>
  );
}
