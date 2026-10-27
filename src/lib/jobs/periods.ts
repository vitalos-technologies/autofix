// Dates and dedupe-key periods for recurring jobs. dedupe_key is unique for
// ever (A49), so recurring work puts its period in the key. Pure.

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (`YYYY-MM-DD`) of an instant in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(at);
}

export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The UTC slot an instant falls in, `YYYY-MM-DDTHH:MMZ`, floored to `minutes`. */
export function utcSlot(at: Date, minutes: number): string {
  const step = Math.max(1, Math.trunc(minutes)) * 60_000;
  return `${new Date(Math.floor(at.getTime() / step) * step).toISOString().slice(0, 16)}Z`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days)).toISOString().slice(0, 10);
}
