/**
 * Today (`/app`): turns the garage's bookings for the day, its open requests and its resources
 * into what the page draws (headline, KPI figures, diary blocks, phone job list, "Needs your OK",
 * summary chips). Pure and clock-free: `now` and the time zone come in.
 */
import type { DiaryBooking } from "@/components/admin-ui/diary-grid";
import { IN_WORKSHOP, holdsResource } from "@/lib/admin/booking-status";
import { bookingDetail, bookingHref, type AdminBooking } from "@/lib/admin/bookings";
import { DEFAULT_TIME_ZONE, greeting, localDateKey, localMinutes } from "@/lib/admin/dates";

export type DiaryResourceRow = { id: string; name: string };

/** One opening window (`opening_hours` row for the day): `08:00:00` style times. */
export type OpeningWindow = { opens: string; closes: string };

/** Bookings that came from a reminder this month (placeholder until `reminder_won_back()`, P3.6). */
export type WonBack = { bookings: number; pence: number };

/** Reminders panel counts, or `null` while the reminders tables do not exist (before P3.6). */
export type ReminderWeek = { due: number; sent: number; booked: number };

/** An unanswered missed call (P3.6 `calls`), or none before that table exists. */
export type MissedCall = { id: string; fromNumber: string; at: string };

export type TodayInput = {
  /** Every booking starting today (any status). */
  today: AdminBooking[];
  /** Bookings waiting for the garage's OK (status `requested`), soonest first. */
  requests: AdminBooking[];
  /** How many requests there are in all (the list may be cut short). */
  requestCount?: number;
  opening: OpeningWindow[];
  now: Date;
  timeZone?: string;
  firstName?: string | null;
};

export type TodayFigures = {
  /** Cars booked in today (confirmed or further, not cancelled or no-show). */
  carsToday: number;
  /** Of those, still to arrive. */
  stillToArrive: number;
  inWorkshop: number;
  waitingParts: number;
  ready: number;
  collected: number;
  toApprove: number;
};

export type TodayView = {
  dateKey: string;
  /** "Morning, Dan. 9 cars in today." */
  headline: string;
  figures: TodayFigures;
  diary: DiaryBooking[];
  /** Phone list, by start time: everything booked in today except requests and released bookings. */
  jobs: AdminBooking[];
  approvals: AdminBooking[];
  hours: { startHour: number; endHour: number };
};

const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 17;

function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Hours the diary shows: the day's opening hours (whole hours around them), widened to fit any
 * booking outside them; 08:00 to 17:00 on a closed day with nothing booked.
 */
export function diaryHours(opening: OpeningWindow[], bookings: Pick<AdminBooking, "startsAt" | "endsAt">[], timeZone = DEFAULT_TIME_ZONE) {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const window of opening) {
    const opens = minutesOf(window.opens);
    const closes = minutesOf(window.closes);
    if (opens !== null && closes !== null && closes > opens) {
      starts.push(opens);
      ends.push(closes);
    }
  }
  for (const booking of bookings) {
    const start = localMinutes(booking.startsAt, timeZone);
    const end = localMinutes(booking.endsAt, timeZone);
    starts.push(start);
    // A booking that runs past midnight is cut at the end of the day.
    ends.push(end > start ? end : 24 * 60);
  }
  if (starts.length === 0) return { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR };
  const startHour = Math.max(0, Math.floor(Math.min(...starts) / 60));
  const endHour = Math.min(24, Math.max(startHour + 1, Math.ceil(Math.max(...ends) / 60)));
  return { startHour, endHour };
}

export function toDiaryBooking(booking: AdminBooking): DiaryBooking {
  return {
    id: booking.id,
    resourceId: booking.resourceId,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    status: booking.status,
    registration: booking.registration,
    service: booking.serviceName,
    vehicle: booking.model ?? booking.make ?? undefined,
    customerName: booking.customerName,
    detail: booking.status === "waiting_parts" ? "waiting on parts" : bookingDetail(booking),
    href: bookingHref(booking.id),
  };
}

function byStart(a: AdminBooking, b: AdminBooking) {
  return a.startsAt.localeCompare(b.startsAt) || a.reference.localeCompare(b.reference);
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function todayHeadline(carsToday: number, now: Date, timeZone = DEFAULT_TIME_ZONE, firstName?: string | null) {
  const hello = firstName?.trim() ? `${greeting(now, timeZone)}, ${firstName.trim()}.` : `${greeting(now, timeZone)}.`;
  const cars = carsToday === 0 ? "No cars in today." : `${plural(carsToday, "car")} in today.`;
  return `${hello} ${cars}`;
}

export function shapeToday({ today, requests, requestCount, opening, now, timeZone = DEFAULT_TIME_ZONE, firstName }: TodayInput): TodayView {
  const dateKey = localDateKey(now, timeZone);
  const onToday = today.filter((booking) => localDateKey(booking.startsAt, timeZone) === dateKey);
  const live = onToday.filter((booking) => holdsResource(booking.status));
  const bookedIn = live.filter((booking) => booking.status !== "requested");

  const figures: TodayFigures = {
    carsToday: bookedIn.length,
    stillToArrive: bookedIn.filter((booking) => booking.status === "confirmed").length,
    inWorkshop: bookedIn.filter((booking) => IN_WORKSHOP.includes(booking.status)).length,
    waitingParts: bookedIn.filter((booking) => booking.status === "waiting_parts").length,
    ready: bookedIn.filter((booking) => booking.status === "ready").length,
    collected: bookedIn.filter((booking) => booking.status === "collected").length,
    toApprove: Math.max(requestCount ?? 0, requests.length),
  };

  return {
    dateKey,
    headline: todayHeadline(figures.carsToday, now, timeZone, firstName),
    figures,
    diary: [...live].sort(byStart).map(toDiaryBooking),
    jobs: [...bookedIn].sort(byStart),
    approvals: [...requests].filter((booking) => booking.status === "requested").sort(byStart),
    hours: diaryHours(opening, live, timeZone),
  };
}

export type TodayChip = { label: string; tone: "navy" | "neutral" | "warning" | "success"; href?: string };

/** The phone Today counts: "9 cars", "2 to approve", "1 waiting parts", "3 ready". */
export function todayChips(figures: TodayFigures, approveHref = "#needs-ok-phone"): TodayChip[] {
  const chips: TodayChip[] = [{ label: plural(figures.carsToday, "car"), tone: "navy" }];
  if (figures.toApprove > 0) chips.push({ label: `${figures.toApprove} to approve`, tone: "neutral", href: approveHref });
  if (figures.waitingParts > 0) chips.push({ label: `${figures.waitingParts} waiting parts`, tone: "warning" });
  if (figures.ready > 0) chips.push({ label: `${figures.ready} ready`, tone: "success" });
  return chips;
}

/** `£1,940` (whole pounds, rounded down). */
export function formatWholePounds(pence: number): string {
  return `£${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(Math.floor(Math.max(0, pence) / 100))}`;
}
