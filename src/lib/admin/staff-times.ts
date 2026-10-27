/**
 * The free time staff type when they book outside opening hours (`/app/bookings/new`, A179): a
 * wall-clock date and time in the garage's time zone, on a 5-minute mark, from today up to two
 * years ahead (A178). Pure and client-safe; the database checks the same limits again and the bay
 * must still be free (no_overlap).
 */
import { addDays, DEFAULT_TIME_ZONE, parseDateKey, zonedInstant } from "@/lib/admin/dates";

export const OVERRIDE_STEP_MINUTES = 5;
export const OVERRIDE_MAX_DAYS = 730;
export const OVERRIDE_HOURS_HINT = "Books a time the garage is normally closed. Bays must still be free.";

export type OverrideTime = { ok: true; startsAt: string } | { ok: false; error: string };

export function checkOverrideTime(value: string, options: { today: string; timeZone?: string }): OverrideTime {
  const text = value.trim();
  if (!text) return { ok: false, error: "Enter the date and time." };
  const format = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!format || !parseDateKey(format[1]) || Number(format[2]) > 23 || Number(format[3]) > 59) return { ok: false, error: "Enter a date and a time, like 27/10/2026 07:30." };
  const [, day = "", , minutes = "0"] = format;
  if (Number(minutes) % OVERRIDE_STEP_MINUTES !== 0) return { ok: false, error: "Use a time on a 5-minute mark, like 07:30 or 07:35." };
  if (day < options.today) return { ok: false, error: "Pick today or a later day." };
  if (day > addDays(options.today, OVERRIDE_MAX_DAYS)) return { ok: false, error: "Pick a day within the next two years." };
  const instant = zonedInstant(text, options.timeZone ?? DEFAULT_TIME_ZONE);
  if (!instant) return { ok: false, error: "That time doesn't exist that day: the clocks go forward. Pick another time." };
  return { ok: true, startsAt: instant.toISOString() };
}
