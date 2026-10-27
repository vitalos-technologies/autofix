/**
 * Garage-local calendar helpers for the admin (Today, Diary, Bookings). Pure and clock-free: the
 * caller passes `now`, and every day boundary is worked out in the garage's time zone, so the
 * diary stays right on the clock-change days (Sun 29 Mar and Sun 25 Oct 2026 in Europe/London).
 */

export const DEFAULT_TIME_ZONE = "Europe/London";

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function wallClock(instant: Date, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** `YYYY-MM-DD` when it is a real calendar date, otherwise `null`. */
export function parseDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE_KEY.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** The local calendar date of an instant, `YYYY-MM-DD`. */
export function localDateKey(value: Date | string, timeZone = DEFAULT_TIME_ZONE): string {
  const instant = value instanceof Date ? value : new Date(value);
  const clock = wallClock(instant, timeZone);
  return `${String(clock.year).padStart(4, "0")}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
}

/** Minutes since local midnight (wall clock). */
export function localMinutes(value: Date | string, timeZone = DEFAULT_TIME_ZONE): number {
  const clock = wallClock(value instanceof Date ? value : new Date(value), timeZone);
  return clock.hour * 60 + clock.minute;
}

function utcNoon(dateKey: string) {
  const match = DATE_KEY.exec(dateKey);
  if (!match) throw new RangeError(`Not a date: ${dateKey}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

/** `dateKey` moved by whole days (calendar arithmetic, no time zone). */
export function addDays(dateKey: string, days: number): string {
  const date = new Date(utcNoon(dateKey) + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday … 7 = Sunday (matches `opening_hours.weekday`). */
export function isoWeekday(dateKey: string): number {
  const day = new Date(utcNoon(dateKey)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday on or before `dateKey`. */
export function weekStart(dateKey: string): string {
  return addDays(dateKey, 1 - isoWeekday(dateKey));
}

/** The seven dates of the week starting `monday`. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/**
 * The instant local midnight starts `dateKey` in `timeZone`. Iterates on the zone offset, so a
 * day that is 23 or 25 hours long still starts and ends at the right instants.
 */
export function startOfLocalDay(dateKey: string, timeZone = DEFAULT_TIME_ZONE): Date {
  const match = DATE_KEY.exec(dateKey);
  if (!match) throw new RangeError(`Not a date: ${dateKey}`);
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let guess = target;
  for (let step = 0; step < 3; step += 1) {
    const clock = wallClock(new Date(guess), timeZone);
    const shown = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
    const correction = target - shown;
    if (correction === 0) break;
    guess += correction;
  }
  return new Date(guess);
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The instant a wall-clock time (`YYYY-MM-DDTHH:MM`, as an `<input type="datetime-local">` gives
 * it) happens in `timeZone`, or `null` when it isn't a real time there: not a date, or inside the
 * hour the clocks skip in spring (01:00-02:00 on Sun 29 Mar 2026 in Europe/London). In the hour
 * that happens twice in autumn the first one (still BST) is taken.
 */
export function zonedInstant(value: string, timeZone = DEFAULT_TIME_ZONE): Date | null {
  const match = LOCAL_DATE_TIME.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (hour > 23 || minute > 59 || !parseDateKey(`${match[1]}-${match[2]}-${match[3]}`)) return null;
  const target = Date.UTC(year, month - 1, day, hour, minute);
  // Each candidate offset of the zone around then; the earliest one whose wall clock matches wins.
  const offsets = new Set<number>();
  for (const probe of [target - 86_400_000, target, target + 86_400_000]) {
    const clock = wallClock(new Date(probe), timeZone);
    offsets.add(Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - probe);
  }
  const matches = [...offsets]
    .map((offset) => target - offset)
    .filter((instant) => {
      const clock = wallClock(new Date(instant), timeZone);
      return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) === target;
    })
    .sort((a, b) => a - b);
  return matches.length > 0 ? new Date(matches[0]!) : null;
}

/** `[start, end)` of the local day as ISO instants, for `starts_at` range queries. */
export function localDayRange(dateKey: string, timeZone = DEFAULT_TIME_ZONE): { from: string; to: string } {
  return { from: startOfLocalDay(dateKey, timeZone).toISOString(), to: startOfLocalDay(addDays(dateKey, 1), timeZone).toISOString() };
}

/** `[Monday 00:00, next Monday 00:00)` of the week holding `dateKey`, as ISO instants. */
export function localWeekRange(dateKey: string, timeZone = DEFAULT_TIME_ZONE): { from: string; to: string; monday: string } {
  const monday = weekStart(dateKey);
  return { monday, from: startOfLocalDay(monday, timeZone).toISOString(), to: startOfLocalDay(addDays(monday, 7), timeZone).toISOString() };
}

/** First of the month holding `dateKey`. */
export function monthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

/** `Tuesday 27 October` for a date key. */
export function formatLongDate(dateKey: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(utcNoon(dateKey)));
}

/** `Tue 27 Oct` for a date key. */
export function formatShortDateKey(dateKey: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).formatToParts(new Date(utcNoon(dateKey)));
  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((item) => item.type === type)?.value ?? "";
    return type === "month" && part === "Sept" ? "Sep" : part;
  };
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

/** `26 Oct` / `26 Oct 2027` (year only when it differs from `currentYear`). */
export function formatDayMonth(dateKey: string, currentYear?: number): string {
  const date = new Date(utcNoon(dateKey));
  const options: Intl.DateTimeFormatOptions = { timeZone: "UTC", day: "numeric", month: "short" };
  if (currentYear !== undefined && date.getUTCFullYear() !== currentYear) options.year = "numeric";
  return new Intl.DateTimeFormat("en-GB", options).format(date).replace("Sept", "Sep");
}

/** "Morning", "Afternoon" or "Evening" for the garage's local time. */
export function greeting(now: Date, timeZone = DEFAULT_TIME_ZONE): "Morning" | "Afternoon" | "Evening" {
  const minutes = localMinutes(now, timeZone);
  if (minutes < 12 * 60) return "Morning";
  if (minutes < 18 * 60) return "Afternoon";
  return "Evening";
}
