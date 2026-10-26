// Messaging send window (CLAUDE.md rule 5): reminders and marketing messages
// go out only 09:00 to 19:00, Monday to Saturday, in the garage's time zone.
//
// Pure and client-safe. Uses Intl.DateTimeFormat for time-zone maths, so it
// follows the IANA rules shipped with Node (BST starts 29 Mar 2026 and ends
// 25 Oct 2026, both Sundays). An unknown time zone throws a RangeError so a
// misconfigured garage never sends at the wrong hour.

export const DEFAULT_TIME_ZONE = "Europe/London";
export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 19;
/** 0 = Sunday, as in Date.getUTCDay(). */
const CLOSED_WEEKDAYS = new Set([0]);

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function assertValidDate(at: Date) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new RangeError("A valid date is required");
}

function wallClock(at: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? NaN,
    month: parts.month ?? NaN,
    day: parts.day ?? NaN,
    hour: parts.hour ?? NaN,
    minute: parts.minute ?? NaN,
    second: parts.second ?? NaN,
  };
}

function weekdayOf(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Offset of the time zone from UTC at that instant, in milliseconds (BST = +3 600 000). */
function offsetMs(at: Date, timeZone: string) {
  const wall = wallClock(at, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const wholeSeconds = at.getTime() - (((at.getTime() % 1000) + 1000) % 1000);
  return asUtc - wholeSeconds;
}

/** The instant at which the wall clock in `timeZone` reads the given local time. */
function zonedTimeToInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallAsUtc - offsetMs(new Date(wallAsUtc), timeZone);
  const corrected = offsetMs(new Date(instant), timeZone);
  if (wallAsUtc - corrected !== instant) instant = wallAsUtc - corrected;
  return new Date(instant);
}

/** True when `at` is 09:00 (inclusive) to 19:00 (exclusive), Monday to Saturday, in the time zone. */
export function isWithinSendWindow(at: Date, timeZone: string = DEFAULT_TIME_ZONE): boolean {
  assertValidDate(at);
  const wall = wallClock(at, timeZone);
  if (CLOSED_WEEKDAYS.has(weekdayOf(wall.year, wall.month, wall.day))) return false;
  return wall.hour >= SEND_WINDOW_START_HOUR && wall.hour < SEND_WINDOW_END_HOUR;
}

/**
 * The earliest instant at or after `at` when sending is allowed. Returns `at`
 * itself inside the window; otherwise 09:00 local on the next open day
 * (Saturday 19:00 and all of Sunday give Monday 09:00).
 */
export function nextSendWindow(at: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  assertValidDate(at);
  if (isWithinSendWindow(at, timeZone)) return new Date(at.getTime());

  const wall = wallClock(at, timeZone);
  let dayOffset = wall.hour < SEND_WINDOW_START_HOUR ? 0 : 1;
  for (let attempt = 0; attempt < 8; attempt += 1, dayOffset += 1) {
    const candidate = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + dayOffset));
    if (CLOSED_WEEKDAYS.has(candidate.getUTCDay())) continue;
    return zonedTimeToInstant(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth() + 1,
      candidate.getUTCDate(),
      SEND_WINDOW_START_HOUR,
      0,
      timeZone,
    );
  }
  throw new RangeError("No send window found within a week");
}
