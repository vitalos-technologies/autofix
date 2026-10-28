// Report date ranges (P5.6). Client-safe and clock-free: the caller passes the garage-local
// `today`. Every date is a garage-local calendar date (`YYYY-MM-DD`, inclusive); the SQL report
// functions turn them into instants in the garage's time zone, so clock-change days are 23 or 25
// hours long there and nothing here needs a time zone.

import { addDays, formatDayMonth, monthStart, parseDateKey } from "@/lib/admin/dates";

export const REPORT_PRESETS = ["this_month", "last_month", "last_90_days", "custom"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const PRESET_LABELS: Record<ReportPreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_90_days: "Last 90 days",
  custom: "Custom dates",
};

/** The SQL functions refuse longer ranges (report_window: at most 366 days). */
export const MAX_REPORT_DAYS = 366;

export type ReportRange = {
  preset: ReportPreset;
  /** First day, garage-local, inclusive. */
  from: string;
  /** Last day, garage-local, inclusive. */
  to: string;
  /** "1 Oct to 31 Oct 2026". */
  label: string;
  days: number;
};

export type RangeProblem = "invalid_dates" | "order" | "too_long";

export const RANGE_PROBLEMS: Record<RangeProblem, string> = {
  invalid_dates: "Choose a start and an end date.",
  order: "The end date must be on or after the start date.",
  too_long: `Choose ${MAX_REPORT_DAYS} days or fewer.`,
};

function lastDayOfMonth(dateKey: string): string {
  const first = monthStart(dateKey);
  const year = Number(first.slice(0, 4));
  const month = Number(first.slice(5, 7));
  return new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10);
}

/** Inclusive number of days from `from` to `to` (calendar days, no time zone). */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

export function rangeLabel(from: string, to: string): string {
  const toYear = Number(to.slice(0, 4));
  const fromLabel = formatDayMonth(from, toYear);
  const toLabel = formatDayMonth(to, -1);
  return from === to ? toLabel : `${fromLabel} to ${toLabel}`;
}

function build(preset: ReportPreset, from: string, to: string): ReportRange {
  return { preset, from, to, label: rangeLabel(from, to), days: dayCount(from, to) };
}

export function presetRange(preset: Exclude<ReportPreset, "custom">, today: string): ReportRange {
  if (preset === "last_month") {
    const end = addDays(monthStart(today), -1);
    return build(preset, monthStart(end), end);
  }
  if (preset === "last_90_days") return build(preset, addDays(today, -89), today);
  return build(preset, monthStart(today), lastDayOfMonth(today));
}

function isPreset(value: unknown): value is ReportPreset {
  return typeof value === "string" && (REPORT_PRESETS as readonly string[]).includes(value);
}

/**
 * The range a report page or export asked for (`?range=last_month`, or `?range=custom&from=&to=`).
 * Anything unreadable falls back to this month, with the problem to show.
 */
export function resolveReportRange(
  input: { range?: unknown; from?: unknown; to?: unknown },
  today: string,
): { range: ReportRange; problem: RangeProblem | null } {
  const preset = isPreset(input.range) ? input.range : input.from || input.to ? "custom" : "this_month";
  if (preset !== "custom") return { range: presetRange(preset, today), problem: null };
  const from = parseDateKey(input.from);
  const to = parseDateKey(input.to);
  const fallback = presetRange("this_month", today);
  if (!from || !to) return { range: fallback, problem: "invalid_dates" };
  if (to < from) return { range: fallback, problem: "order" };
  if (dayCount(from, to) > MAX_REPORT_DAYS) return { range: fallback, problem: "too_long" };
  return { range: build("custom", from, to), problem: null };
}

/** Query string for a range (only dates and the preset name; never anything about a customer). */
export function rangeQuery(range: Pick<ReportRange, "preset" | "from" | "to">): string {
  const params = new URLSearchParams({ range: range.preset });
  if (range.preset === "custom") {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  return params.toString();
}
