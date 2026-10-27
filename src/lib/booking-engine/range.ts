/**
 * `tstzrange` helpers for `bookings.during` (the time a resource is blocked:
 * travel + duration + buffer). Pure, so the parsing of PostgREST's text form is
 * unit tested.
 */

export type TimeRange = { start: Date; end: Date };

/** Postgres prints offsets as `+00`, `+01`, `+05:30`; JavaScript wants `+00:00`. */
function parseTimestamp(raw: string): Date | null {
  let value = raw.trim().replace(/^"|"$/g, "");
  if (!value) return null;
  value = value.replace(" ", "T");
  value = value.replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2})$/, "$1:00");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parses `["2026-11-02 09:00:00+00","2026-11-02 10:30:00+00")` (PostgREST's
 * text form of a tstzrange). Only bounded `[start,end)` ranges are bookings;
 * anything else returns null.
 */
export function parseTimeRange(value: unknown): TimeRange | null {
  if (typeof value !== "string") return null;
  const match = /^\[\s*("?)([^",]+)\1\s*,\s*("?)([^")\]]+)\3\s*\)$/.exec(value.trim());
  if (!match) return null;
  const start = parseTimestamp(match[2] ?? "");
  const end = parseTimestamp(match[4] ?? "");
  if (!start || !end || end <= start) return null;
  return { start, end };
}

/** The literal PostgREST accepts for a `tstzrange` value or filter: `[start,end)`. */
export function formatTimeRange(range: TimeRange): string {
  return `[${range.start.toISOString()},${range.end.toISOString()})`;
}

export function shiftTimeRange(range: TimeRange, milliseconds: number): TimeRange {
  return { start: new Date(range.start.getTime() + milliseconds), end: new Date(range.end.getTime() + milliseconds) };
}

/** Normalises any timestamp PostgREST returns (`2026-11-02T09:00:00+00:00`) to `toISOString()` form. */
export function isoInstant(value: string): string | null {
  const date = parseTimestamp(value);
  return date ? date.toISOString() : null;
}
