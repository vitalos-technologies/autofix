import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { formatDuration, type DateStripDay, type TimeSlot } from "@/components/book";
import { getBookingEngine, type OnlineService, type Slot } from "@/lib/booking-engine";
import { readBookingSession } from "@/lib/booking-engine/state";
import { LOCATION_LABELS } from "@/lib/booking-flow/copy";
import { addDays, dateKeyInZone, isDateKey } from "@/lib/booking-flow/dates";
import { loadBookingServices } from "@/lib/booking-flow/server";
import { redirectForStep } from "@/lib/booking-flow/steps";
import { releaseExpiredDeposits } from "@/lib/payments/server";
import { formatPhoneForDisplay } from "@/lib/tenancy/contact";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen, BookingUnavailable } from "../_components/booking-screen";
import { TimeStep } from "../_components/time-step";

export const metadata: Metadata = { title: "Pick a time", robots: { index: false, follow: false } };

/** Days offered in the strip (fewer when the service can only be booked a short way ahead). */
const STRIP_DAYS = 14;

function toTimeSlot(slot: Slot): TimeSlot {
  return { starts_at: slot.startsAt, ends_at: slot.endsAt, free_count: slot.freeCount };
}

type TimePageProps = {
  params: Promise<{ garageId: string }>;
  /** `?date=YYYY-MM-DD` only: the day is not personal data. */
  searchParams: Promise<{ date?: string | string[] }>;
};

/** Book 3 · Time. Needs the car and the service; reads two weeks of slots from the diary. */
export default async function TimePage({ params, searchParams }: TimePageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const { draft, meta } = await readBookingSession(garage.id);
  if (redirectForStep("time", draft, null) === "/") redirect("/");
  // P5.4: a slot held for a deposit that was never paid is free again before times are shown.
  await releaseExpiredDeposits(garage.id);

  const back = { href: "/service", label: "Back to service" };
  const unavailable = (
    <BookingScreen garage={garage} step={3} subtitle="Pick a time" back={back} withActionBar={false}>
      <BookingUnavailable garage={garage} title="We can't read the diary right now" />
    </BookingScreen>
  );

  let services: OnlineService[];
  try {
    services = await loadBookingServices(garage);
  } catch {
    return unavailable;
  }
  const target = redirectForStep("time", draft, services);
  if (target) redirect(target);
  const service = services.find((item) => item.id === draft.serviceId)!;
  const locationMode = draft.locationMode!;

  const today = dateKeyInZone(new Date(), garage.timezone);
  const dayCount = Math.max(1, Math.min(STRIP_DAYS, service.maxDaysAhead + 1));
  const lastDay = addDays(today, dayCount - 1);
  let slots: Slot[];
  try {
    slots = await getBookingEngine().getAvailableSlots({
      garageId: garage.id,
      serviceId: service.id,
      from: today,
      to: lastDay,
      locationMode,
    });
  } catch {
    return unavailable;
  }

  const slotsByDate: Record<string, TimeSlot[]> = {};
  const days: DateStripDay[] = [];
  for (let index = 0; index < dayCount; index += 1) slotsByDate[addDays(today, index)] = [];
  for (const slot of slots) {
    const day = dateKeyInZone(slot.startsAt, garage.timezone);
    slotsByDate[day]?.push(toTimeSlot(slot));
  }
  for (const [date, daySlots] of Object.entries(slotsByDate)) {
    days.push({ date, disabled: !daySlots.some((slot) => slot.free_count > 0) });
  }

  const free = slots.filter((slot) => slot.freeCount > 0);
  const draftStart = draft.startsAt && free.some((slot) => Date.parse(slot.startsAt) === Date.parse(draft.startsAt!)) ? draft.startsAt : null;
  const requested = (await searchParams).date;
  const requestedDate = typeof requested === "string" && isDateKey(requested) && slotsByDate[requested] ? requested : null;
  const draftDate = draftStart ? dateKeyInZone(draftStart, garage.timezone) : null;
  const firstOpen = days.find((day) => !day.disabled)?.date ?? null;
  const initialDate = requestedDate ?? draftDate ?? firstOpen ?? today;

  const slotTaken = !draft.startsAt && meta.slotTaken
    ? { startsAt: meta.slotTaken.startsAt, alternatives: meta.slotTaken.alternatives.filter((slot) => slot.freeCount > 0).map(toTimeSlot) }
    : null;
  const phone = formatPhoneForDisplay(garage.phone);
  const noTimesMessage = firstOpen
    ? null
    : `There are no online times in the next ${dayCount === 1 ? "day" : `${dayCount} days`}.${phone ? ` Call us on ${phone} and we'll fit you in.` : ""}`;

  const subtitle = [service.name, service.priceMode === "quote" ? null : formatDuration(service.durationMin), LOCATION_LABELS[locationMode]]
    .filter(Boolean)
    .join(" · ");

  return (
    <BookingScreen garage={garage} step={3} subtitle={subtitle} back={back}>
      <TimeStep
        days={days}
        slotsByDate={slotsByDate}
        initialDate={initialDate}
        initialStart={draftStart}
        timeZone={garage.timezone}
        locationMode={locationMode}
        slotTaken={slotTaken}
        noTimesMessage={noTimesMessage}
      />
    </BookingScreen>
  );
}
