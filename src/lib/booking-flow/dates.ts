/**
 * Calendar-date helpers for the booking flow. Pure and client-safe.
 * A "date key" is a local calendar date in the garage's time zone, `YYYY-MM-DD`.
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

/** `2026-10-27` + 6 → `2026-11-02`. */
export function addDays(dateKey: string, days: number): string {
  const match = DATE_KEY.exec(dateKey);
  if (!match) throw new RangeError(`Not a date key: ${dateKey}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both date keys). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a date key. */
export function isoWeekday(dateKey: string): number {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** The local calendar date of an instant in the time zone. */
export function dateKeyInZone(value: string | Date, timeZone: string): string {
  const parts = zonedParts(value instanceof Date ? value : new Date(value), timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Offset of the time zone from UTC at the instant, in minutes (Europe/London: 0 or 60). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant of a local wall-clock time (`minutes` after midnight) on a date in the time zone.
 * Times that do not exist (the hour skipped when clocks go forward) move forward by the gap,
 * the way Postgres `timestamp at time zone` does.
 */
export function zonedTimeToInstant(dateKey: string, minutes: number, timeZone: string): Date {
  const match = DATE_KEY.exec(dateKey);
  if (!match) throw new RangeError(`Not a date key: ${dateKey}`);
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, minutes);
  const first = offsetMinutes(new Date(wall), timeZone);
  const guess = wall - first * 60_000;
  const second = offsetMinutes(new Date(guess), timeZone);
  return new Date(second === first ? guess : wall - Math.min(first, second) * 60_000);
}
