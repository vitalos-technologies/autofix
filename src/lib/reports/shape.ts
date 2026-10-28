// Shaping the SQL report rows for the page and the CSV exports (P5.6). Client-safe and pure.
// Definitions (what counts, from which table) live in the SQL functions of
// supabase/migrations/20261029000600_reports.sql and in docs/autofix/phase-5/P5.6-reports.md.

import { weekStart } from "@/lib/admin/dates";
import { poundsCell, toCsv, type CsvValue } from "./csv";
import type { ReportRange } from "./range";

export const REPORT_KINDS = ["revenue-by-service", "revenue-by-technician", "bay-utilisation", "hours", "reminder-roi"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_TITLES: Record<ReportKind, string> = {
  "revenue-by-service": "Revenue by service",
  "revenue-by-technician": "Revenue by technician",
  "bay-utilisation": "Bay utilisation",
  hours: "Hours sold vs worked",
  "reminder-roi": "Reminder return",
};

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);
}

export type RevenueRow = {
  key: string;
  name: string;
  bookings: number;
  invoicedPence: number;
  estimatedPence: number;
  totalPence: number;
};

export type UtilisationDay = {
  resourceId: string;
  resourceName: string;
  resourceKind: string;
  day: string;
  openMinutes: number;
  bookedMinutes: number;
};

export type HoursRow = {
  key: string;
  name: string;
  jobs: number;
  measuredJobs: number;
  soldMinutes: number;
  workedMinutes: number;
};

export type ReminderRoiRow = {
  kind: string;
  sent: number;
  booked: number;
  pence: number;
  smsSegments: number;
};

export type CampaignRoi = { available: boolean; sent: number; booked: number; pence: number };

export const UNASSIGNED_LABEL = "Unassigned";

const KIND_NAMES: Record<string, string> = { mot: "MOT reminders", service: "Service reminders", review: "Review requests" };

export function reminderKindName(kind: string): string {
  return KIND_NAMES[kind] ?? kind;
}

const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

// ---------------------------------------------------------------------------
// From the database rows (snake_case, bigint as number or string)
// ---------------------------------------------------------------------------

export function revenueRowsFromService(rows: readonly Record<string, unknown>[]): RevenueRow[] {
  return rows.map((row) => ({
    key: text(row.service_id) || "none",
    name: text(row.service_name) || "Service removed",
    bookings: num(row.bookings),
    invoicedPence: num(row.invoiced_pence),
    estimatedPence: num(row.estimated_pence),
    totalPence: num(row.total_pence),
  }));
}

export function revenueRowsFromTechnician(rows: readonly Record<string, unknown>[]): RevenueRow[] {
  return rows.map((row) => ({
    key: row.technician_name == null ? "unassigned" : `${text(row.technician_id) || "former"}:${text(row.technician_name)}`,
    name: row.technician_name == null ? UNASSIGNED_LABEL : text(row.technician_name),
    bookings: num(row.bookings),
    invoicedPence: num(row.invoiced_pence),
    estimatedPence: num(row.estimated_pence),
    totalPence: num(row.total_pence),
  }));
}

export function utilisationFromRows(rows: readonly Record<string, unknown>[]): UtilisationDay[] {
  return rows.map((row) => ({
    resourceId: text(row.resource_id),
    resourceName: text(row.resource_name),
    resourceKind: text(row.resource_kind),
    day: text(row.day).slice(0, 10),
    openMinutes: num(row.open_minutes),
    bookedMinutes: num(row.booked_minutes),
  }));
}

export function hoursFromRows(rows: readonly Record<string, unknown>[]): HoursRow[] {
  return rows.map((row) => ({
    key: row.technician_name == null ? "unassigned" : `${text(row.technician_id) || "former"}:${text(row.technician_name)}`,
    name: row.technician_name == null ? UNASSIGNED_LABEL : text(row.technician_name),
    jobs: num(row.jobs),
    measuredJobs: num(row.measured_jobs),
    soldMinutes: num(row.sold_minutes),
    workedMinutes: num(row.worked_minutes),
  }));
}

export function reminderRoiFromRows(rows: readonly Record<string, unknown>[]): ReminderRoiRow[] {
  return rows.map((row) => ({
    kind: text(row.kind),
    sent: num(row.sent),
    booked: num(row.booked),
    pence: num(row.pence),
    smsSegments: num(row.sms_segments),
  }));
}

export function campaignRoiFromRow(row: Record<string, unknown> | undefined | null): CampaignRoi {
  return { available: row?.available === true, sent: num(row?.sent), booked: num(row?.booked), pence: num(row?.pence) };
}

// ---------------------------------------------------------------------------
// Totals and summaries
// ---------------------------------------------------------------------------

export function revenueTotals(rows: readonly RevenueRow[]): Omit<RevenueRow, "key" | "name"> {
  return rows.reduce(
    (sum, row) => ({
      bookings: sum.bookings + row.bookings,
      invoicedPence: sum.invoicedPence + row.invoicedPence,
      estimatedPence: sum.estimatedPence + row.estimatedPence,
      totalPence: sum.totalPence + row.totalPence,
    }),
    { bookings: 0, invoicedPence: 0, estimatedPence: 0, totalPence: 0 },
  );
}

export type UtilisationSummary = {
  resourceId: string;
  resourceName: string;
  resourceKind: string;
  openMinutes: number;
  bookedMinutes: number;
};

/** One row per resource over the whole range, in the order the database returned them. */
export function utilisationByResource(days: readonly UtilisationDay[]): UtilisationSummary[] {
  const byResource = new Map<string, UtilisationSummary>();
  for (const day of days) {
    const current = byResource.get(day.resourceId) ?? {
      resourceId: day.resourceId,
      resourceName: day.resourceName,
      resourceKind: day.resourceKind,
      openMinutes: 0,
      bookedMinutes: 0,
    };
    current.openMinutes += day.openMinutes;
    current.bookedMinutes += day.bookedMinutes;
    byResource.set(day.resourceId, current);
  }
  return [...byResource.values()];
}

export type UtilisationWeek = { monday: string; openMinutes: number; bookedMinutes: number };

/** All resources together, per ISO week (Monday key), for the week-by-week table. */
export function utilisationByWeek(days: readonly UtilisationDay[]): UtilisationWeek[] {
  const byWeek = new Map<string, UtilisationWeek>();
  for (const day of days) {
    const monday = weekStart(day.day);
    const current = byWeek.get(monday) ?? { monday, openMinutes: 0, bookedMinutes: 0 };
    current.openMinutes += day.openMinutes;
    current.bookedMinutes += day.bookedMinutes;
    byWeek.set(monday, current);
  }
  return [...byWeek.values()].sort((a, b) => a.monday.localeCompare(b.monday));
}

/** 0..1, or null when nothing was open. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** "42%", or "No open hours" when nothing was open. */
export function formatShare(part: number, whole: number): string {
  const value = share(part, whole);
  if (value === null) return "No open hours";
  if (value > 0 && value < 0.01) return "Under 1%";
  return `${Math.round(value * 100)}%`;
}

/** "12 h 30 min", "45 min", "0 h". */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return rest === 0 ? "0 h" : `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Hours with one decimal for CSV cells. */
export function hoursCell(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** "£1,234.50". */
export function formatPounds(pence: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Math.round(pence) / 100);
}

export function hoursTotals(rows: readonly HoursRow[]): Omit<HoursRow, "key" | "name"> {
  return rows.reduce(
    (sum, row) => ({
      jobs: sum.jobs + row.jobs,
      measuredJobs: sum.measuredJobs + row.measuredJobs,
      soldMinutes: sum.soldMinutes + row.soldMinutes,
      workedMinutes: sum.workedMinutes + row.workedMinutes,
    }),
    { jobs: 0, measuredJobs: 0, soldMinutes: 0, workedMinutes: 0 },
  );
}

/** Worked as a share of sold: "92%" (under 100% = quicker than sold). */
export function efficiency(row: Pick<HoursRow, "soldMinutes" | "workedMinutes">): string {
  return row.soldMinutes > 0 && row.workedMinutes > 0 ? `${Math.round((row.soldMinutes / row.workedMinutes) * 100)}%` : "Not measured";
}

export type RoiSummary = { sent: number; booked: number; pence: number; smsSegments: number; smsCostPence: number | null };

/** Totals; the SMS cost only when the per-segment cost is set (A339). */
export function roiTotals(rows: readonly ReminderRoiRow[], costPerSegmentPence: number | null): RoiSummary {
  const sum = rows.reduce(
    (total, row) => ({
      sent: total.sent + row.sent,
      booked: total.booked + row.booked,
      pence: total.pence + row.pence,
      smsSegments: total.smsSegments + row.smsSegments,
    }),
    { sent: 0, booked: 0, pence: 0, smsSegments: 0 },
  );
  return { ...sum, smsCostPence: smsCost(sum.smsSegments, costPerSegmentPence) };
}

export function smsCost(segments: number, costPerSegmentPence: number | null): number | null {
  return costPerSegmentPence === null ? null : Math.round(segments * costPerSegmentPence);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function reportFileName(kind: ReportKind, range: Pick<ReportRange, "from" | "to">): string {
  return `autofix-${kind}-${range.from}-to-${range.to}.csv`;
}

export function revenueCsv(rows: readonly RevenueRow[], heading: "Service" | "Technician"): string {
  const total = revenueTotals(rows);
  return toCsv(
    [heading, "Bookings", "Invoiced GBP", "Estimated GBP (no invoice yet)", "Total GBP"],
    [
      ...rows.map((row) => [row.name, row.bookings, poundsCell(row.invoicedPence), poundsCell(row.estimatedPence), poundsCell(row.totalPence)]),
      ["Total", total.bookings, poundsCell(total.invoicedPence), poundsCell(total.estimatedPence), poundsCell(total.totalPence)],
    ],
  );
}

export function utilisationCsv(days: readonly UtilisationDay[]): string {
  return toCsv(
    ["Date", "Resource", "Kind", "Open hours", "Booked hours", "Utilisation %"],
    days.map((day) => [
      day.day,
      day.resourceName,
      day.resourceKind,
      hoursCell(day.openMinutes),
      hoursCell(day.bookedMinutes),
      day.openMinutes > 0 ? Math.round((day.bookedMinutes / day.openMinutes) * 1000) / 10 : null,
    ]),
  );
}

export function hoursCsv(rows: readonly HoursRow[]): string {
  const total = hoursTotals(rows);
  const line = (name: string, row: Omit<HoursRow, "key" | "name">) => [
    name,
    row.jobs,
    row.measuredJobs,
    hoursCell(row.soldMinutes),
    hoursCell(row.workedMinutes),
    row.soldMinutes > 0 && row.workedMinutes > 0 ? Math.round((row.soldMinutes / row.workedMinutes) * 1000) / 10 : null,
  ];
  return toCsv(
    ["Technician", "Jobs started", "Jobs finished (measured)", "Hours sold", "Hours worked", "Sold vs worked %"],
    [...rows.map((row) => line(row.name, row)), line("Total", total)],
  );
}

export function reminderRoiCsv(rows: readonly ReminderRoiRow[], campaign: CampaignRoi, costPerSegmentPence: number | null): string {
  const withCost = costPerSegmentPence !== null;
  const header = ["Source", "Sent", "Bookings", "Won back GBP", "SMS segments", ...(withCost ? ["SMS cost GBP"] : [])];
  const body: CsvValue[][] = rows.map((row) => [
    reminderKindName(row.kind),
    row.sent,
    row.booked,
    poundsCell(row.pence),
    row.smsSegments,
    ...(withCost ? [poundsCell(smsCost(row.smsSegments, costPerSegmentPence) ?? 0)] : []),
  ]);
  const total = roiTotals(rows, costPerSegmentPence);
  body.push(["All reminders", total.sent, total.booked, poundsCell(total.pence), total.smsSegments, ...(withCost ? [poundsCell(total.smsCostPence ?? 0)] : [])]);
  if (campaign.available) {
    body.push(["Campaigns", campaign.sent, campaign.booked, poundsCell(campaign.pence), null, ...(withCost ? [null] : [])]);
  }
  return toCsv(header, body);
}
