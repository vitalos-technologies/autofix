/**
 * Display formatting shared by the booking components. Pure functions, no data access.
 * Times are always shown in the garage's time zone (UK garages: Europe/London).
 */

export const DEFAULT_GARAGE_TIME_ZONE = "Europe/London";

/** How a service is priced (`services.price_mode`). */
export type PriceMode = "fixed" | "from" | "quote";

/** Morning before 12:00, afternoon 12:00 to 16:59, evening from 17:00 (garage local time). */
export type DayPeriod = "morning" | "afternoon" | "evening";

export const DAY_PERIOD_LABELS: Record<DayPeriod, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `4500` → `£45`, `4550` → `£45.50`. */
export function formatPounds(pence: number): string {
  const pounds = Math.round(pence) / 100;
  const whole = Number.isInteger(pounds);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(pounds);
}

/** Price shown on a service: `£x`, `From £x` or `Quote` (also `Quote` when no price is set). */
export function formatServicePrice(pricePence: number | null | undefined, priceMode: PriceMode): string {
  if (priceMode === "quote" || pricePence === null || pricePence === undefined || !Number.isFinite(pricePence) || pricePence < 0) {
    return "Quote";
  }
  if (priceMode === "fixed" && pricePence === 0) return "Free";
  const amount = formatPounds(pricePence);
  return priceMode === "from" ? `From ${amount}` : amount;
}

/** `45` → `45 min`, `60` → `1 hr`, `150` → `2.5 hrs`, `75` → `1 hr 15 min`. Empty for no duration. */
export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return "";
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  if (total % 30 === 0) {
    const hours = total / 60;
    return `${hours} ${hours === 1 ? "hr" : "hrs"}`;
  }
  const hours = Math.floor(total / 60);
  return `${hours} ${hours === 1 ? "hr" : "hrs"} ${total % 60} min`;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function parts(value: string | Date, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const formatted = new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).formatToParts(toDate(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const part = formatted.find((item) => item.type === type)?.value ?? "";
    // Newer ICU writes "Sept" for en-GB; the designs use three-letter months throughout.
    return type === "month" && options.month === "short" && part === "Sept" ? "Sep" : part;
  };
  return get;
}

/** `09:15` in the garage's time zone (24-hour clock). */
export function formatTime(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  const get = parts(value, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${get("hour")}:${get("minute")}`;
}

/** `Tue 27 Oct` in the garage's time zone. */
export function formatShortDate(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  const get = parts(value, timeZone, { weekday: "short", day: "numeric", month: "short" });
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

/** `Tue 27 Oct, 09:15`: the action bar label and confirmation "When". */
export function formatSlotLabel(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  return `${formatShortDate(value, timeZone)}, ${formatTime(value, timeZone)}`;
}

/** `Tue 27 Oct · 09:15`: the summary bar line. */
export function formatSummaryWhen(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  return `${formatShortDate(value, timeZone)} · ${formatTime(value, timeZone)}`;
}

/** Hour of the day (0 to 23) in the garage's time zone. */
export function localHour(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): number {
  const get = parts(value, timeZone, { hour: "2-digit", hourCycle: "h23" });
  return Number.parseInt(get("hour"), 10);
}

export function dayPeriod(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): DayPeriod {
  const hour = localHour(value, timeZone);
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/**
 * Parses a calendar date. `YYYY-MM-DD` (a Postgres `date`) is read as that day, with no time-zone
 * shift; anything else goes through `Date`. Returns `null` when invalid.
 */
export function parseCalendarDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const match = ISO_DATE_ONLY.exec(value);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarTimeZone(value: string | Date, timeZone: string) {
  return typeof value === "string" && ISO_DATE_ONLY.test(value) ? "UTC" : timeZone;
}

/** `14 Mar 2027` (MOT due dates). Empty string for an invalid date. */
export function formatCalendarDate(value: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  const date = parseCalendarDate(value);
  if (!date) return "";
  const get = parts(date, calendarTimeZone(value, timeZone), { day: "numeric", month: "short", year: "numeric" });
  return `${get("day")} ${get("month")} ${get("year")}`;
}

/** Day-strip parts for a `YYYY-MM-DD` date: `{ weekday: "Tue", day: "27", full: "Tuesday 27 October" }`. */
export function dayStripParts(date: string, timeZone = DEFAULT_GARAGE_TIME_ZONE) {
  const parsed = parseCalendarDate(date);
  if (!parsed) return { weekday: "", day: "", full: date };
  const zone = calendarTimeZone(date, timeZone);
  const short = parts(parsed, zone, { weekday: "short", day: "numeric" });
  const long = parts(parsed, zone, { weekday: "long", day: "numeric", month: "long" });
  return { weekday: short("weekday"), day: short("day"), full: `${long("weekday")} ${long("day")} ${long("month")}` };
}

/** Today's date (`YYYY-MM-DD`) in the garage's time zone. */
export function localDateKey(value: Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  const get = parts(value, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** `48210` → `48,210`. */
export function formatMileage(miles: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(miles);
}

/** `Hartley Road Motors` → `HR`; one word → its first two letters. */
export function garageInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word));
  if (words.length === 0) return "";
  if (words.length === 1) return (words[0] ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, "").charAt(0))
    .join("")
    .toUpperCase();
}
