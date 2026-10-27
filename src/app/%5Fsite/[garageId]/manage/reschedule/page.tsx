import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { DateStripDay, TimeSlot } from "@/components/book";
import { LOCATION_LABELS } from "@/lib/booking-flow/copy";
import { addDays, dateKeyInZone, daysBetween, isDateKey } from "@/lib/booking-flow/dates";
import { loadRescheduleSlots, readManagedBooking, RESCHEDULE_DAYS, toManageBookingView } from "@/lib/booking-flow/manage-server";
import { canChangeOnline } from "@/lib/booking-flow/manage-view";
import { formatPhoneForDisplay } from "@/lib/tenancy/contact";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen, BookingUnavailable } from "../../_components/booking-screen";
import { ManageReschedule } from "../../_components/manage-reschedule";

export const metadata: Metadata = { title: "Change the time", robots: { index: false, follow: false, nocache: true } };

type ReschedulePageProps = {
  params: Promise<{ garageId: string }>;
  /** `?date=YYYY-MM-DD` only: the day is not personal data. */
  searchParams: Promise<{ date?: string | string[] }>;
};

const BACK = { href: "/manage", label: "Back to your booking" };

/** Move a booking: two weeks of the booking's own service slots, from the same diary as Book 3. */
export default async function ReschedulePage({ params, searchParams }: ReschedulePageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const session = await readManagedBooking(garage.id);
  if (session.kind !== "open") redirect("/manage");
  const booking = session.booking;
  // Too close, already with the garage, over or cancelled: the booking page explains what to do.
  if (!canChangeOnline(toManageBookingView(booking).state)) redirect("/manage");

  const subtitle = [booking.service.name, LOCATION_LABELS[booking.locationMode]].join(" · ");
  const result = await loadRescheduleSlots(booking);
  if (!result.ok) {
    return (
      <BookingScreen garage={garage} subtitle={subtitle} back={BACK} withActionBar={false}>
        <BookingUnavailable
          garage={garage}
          title={result.reason === "not_online" ? "This booking can't be moved online" : "We can't read the diary right now"}
        />
      </BookingScreen>
    );
  }

  const timeZone = garage.timezone;
  const dayCount = daysBetween(result.today, result.lastDay) + 1;
  const slotsByDate: Record<string, TimeSlot[]> = {};
  for (let index = 0; index < Math.min(dayCount, RESCHEDULE_DAYS); index += 1) slotsByDate[addDays(result.today, index)] = [];
  for (const slot of result.slots) {
    const day = dateKeyInZone(slot.startsAt, timeZone);
    // The booking's own time is shown as taken: moving it there changes nothing.
    const own = Date.parse(slot.startsAt) === Date.parse(booking.startsAt);
    slotsByDate[day]?.push({ starts_at: slot.startsAt, ends_at: slot.endsAt, free_count: own ? 0 : slot.freeCount });
  }
  const days: DateStripDay[] = Object.entries(slotsByDate).map(([date, daySlots]) => ({ date, disabled: !daySlots.some((slot) => slot.free_count > 0) }));

  const firstOpen = days.find((day) => !day.disabled)?.date ?? null;
  const requested = (await searchParams).date;
  const requestedDate = typeof requested === "string" && isDateKey(requested) && slotsByDate[requested] ? requested : null;
  const currentDate = dateKeyInZone(booking.startsAt, timeZone);
  const initialDate = requestedDate ?? (slotsByDate[currentDate] ? currentDate : null) ?? firstOpen ?? result.today;
  const phone = formatPhoneForDisplay(garage.phone);
  const noTimesMessage = firstOpen
    ? null
    : `There are no other online times in the next ${RESCHEDULE_DAYS} days.${phone ? ` Call us on ${phone} and we'll find you a time.` : ""}`;

  return (
    <BookingScreen garage={garage} subtitle={subtitle} back={BACK}>
      <ManageReschedule
        days={days}
        slotsByDate={slotsByDate}
        initialDate={initialDate}
        currentStart={booking.startsAt}
        timeZone={timeZone}
        locationMode={booking.locationMode}
        noTimesMessage={noTimesMessage}
      />
    </BookingScreen>
  );
}
