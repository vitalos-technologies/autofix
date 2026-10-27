/**
 * Diary week view (`/app/diary`): bookings by resource and day. Pure.
 */
import { holdsResource } from "@/lib/admin/booking-status";
import type { AdminBooking } from "@/lib/admin/bookings";
import { addDays, DEFAULT_TIME_ZONE, isoWeekday, localDateKey, parseDateKey, weekDates, weekStart } from "@/lib/admin/dates";
import type { DiaryResourceRow, OpeningWindow } from "@/lib/admin/today";

export const UNASSIGNED_ROW = "__unassigned__";

export type WeekDay = { date: string; open: boolean; isToday: boolean; count: number };

export type WeekView = {
  monday: string;
  days: WeekDay[];
  rows: DiaryResourceRow[];
  /** `cells[resourceId][date]` → bookings soonest first. */
  cells: Record<string, Record<string, AdminBooking[]>>;
  /** Bookings by day, for the phone list. */
  byDay: Record<string, AdminBooking[]>;
  total: number;
};

/** `?week=` (any date in the week) or `?day=`; today's week otherwise. */
export function diaryParams(params: Record<string, string | string[] | undefined>, today: string) {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const day = parseDateKey(first(params.day));
  const week = parseDateKey(first(params.week));
  return { day, monday: weekStart(day ?? week ?? today) };
}

export function shapeWeek({
  bookings,
  resources,
  opening,
  monday,
  now,
  timeZone = DEFAULT_TIME_ZONE,
}: {
  bookings: AdminBooking[];
  resources: DiaryResourceRow[];
  opening: Map<number, OpeningWindow[]>;
  monday: string;
  now: Date;
  timeZone?: string;
}): WeekView {
  const dates = weekDates(monday);
  const today = localDateKey(now, timeZone);
  const live = bookings
    .filter((booking) => holdsResource(booking.status))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.reference.localeCompare(b.reference));
  const known = new Set(resources.map((resource) => resource.id));
  const rows = live.some((booking) => !booking.resourceId || !known.has(booking.resourceId))
    ? [...resources, { id: UNASSIGNED_ROW, name: "Unassigned" }]
    : resources;

  const cells: WeekView["cells"] = Object.fromEntries(rows.map((row) => [row.id, Object.fromEntries(dates.map((date) => [date, [] as AdminBooking[]]))]));
  const byDay: WeekView["byDay"] = Object.fromEntries(dates.map((date) => [date, [] as AdminBooking[]]));
  for (const booking of live) {
    const date = localDateKey(booking.startsAt, timeZone);
    if (!byDay[date]) continue;
    const row = booking.resourceId && known.has(booking.resourceId) ? booking.resourceId : UNASSIGNED_ROW;
    cells[row]![date]!.push(booking);
    byDay[date]!.push(booking);
  }

  return {
    monday,
    days: dates.map((date) => ({ date, open: (opening.get(isoWeekday(date)) ?? []).length > 0, isToday: date === today, count: byDay[date]!.length })),
    rows,
    cells,
    byDay,
    total: dates.reduce((sum, date) => sum + byDay[date]!.length, 0),
  };
}

export function diaryWeekHref(monday: string) {
  return `/app/diary?week=${monday}`;
}

export function diaryDayHref(date: string) {
  return `/app/diary?day=${date}`;
}

export function neighbourWeeks(monday: string) {
  return { previous: addDays(monday, -7), next: addDays(monday, 7) };
}
