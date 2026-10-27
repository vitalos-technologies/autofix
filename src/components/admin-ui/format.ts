/**
 * Display helpers for the admin components. Pure; times are always read in the garage's time zone,
 * so a 09:15 booking sits at 09:15 on the diary on both sides of a clock change.
 */
import { DEFAULT_GARAGE_TIME_ZONE, formatTime, garageInitials } from "@/components/book/format";

export { DEFAULT_GARAGE_TIME_ZONE, formatTime };

export type ZonedMoment = {
  /** Local calendar date, `YYYY-MM-DD`. */
  dateKey: string;
  /** Minutes since local midnight (wall clock), 0 to 1439. */
  minutes: number;
};

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string) {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Local date and wall-clock minutes of an instant in `timeZone`. `null` for an invalid date. */
export function zonedMoment(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): ZonedMoment | null {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number.parseInt(get("hour"), 10) % 24;
  const minute = Number.parseInt(get("minute"), 10);
  return { dateKey: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + minute };
}

/** `09:15 to 10:15` in the garage's time zone. */
export function formatTimeRange(start: string | Date, end: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  return `${formatTime(start, timeZone)} to ${formatTime(end, timeZone)}`;
}

/** `Wed 28, 09:15` (the "Needs your OK" card). */
export function formatDayAndTime(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric" }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")}, ${formatTime(date, timeZone)}`;
}

/** `Tue 27 Oct` for a `YYYY-MM-DD` calendar date (no time-zone shift). */
export function formatDateKey(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((item) => item.type === type)?.value ?? "";
    return type === "month" && part === "Sept" ? "Sep" : part;
  };
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

/** `00:00`-style label for minutes since midnight. */
export function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** `Dan Morris` → `DM`; `dan@example.com` → `DA`. */
export function personInitials(name: string): string {
  const cleaned = name.includes("@") ? (name.split("@")[0] ?? "") : name;
  return garageInitials(cleaned.replace(/[._-]+/g, " "));
}

/** `3` → `3`, `120` → `99+`. */
export function formatCount(count: number): string {
  return count > 99 ? "99+" : String(Math.max(0, Math.floor(count)));
}
