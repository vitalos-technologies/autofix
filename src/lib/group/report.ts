// Multi-site (P5.9): shapes what group_summary(), group_overview() and group_report() return into
// what /app/group draws and exports. Pure and clock-free (dates come in), so it is client-safe.

import { addDays, monthStart, parseDateKey } from "@/lib/admin/dates";
import { formatPlanPrice } from "@/lib/plans/config";

export type GroupSummary = {
  groupId: string | null;
  groupName: string | null;
  homeGarageId: string;
  isHome: boolean;
  /** Every site in the group (1 when the garage is in no group yet). */
  siteCount: number;
  /** Sites the member is owner or manager of (what the figures add up). */
  visibleSites: number;
  canAddSites: boolean;
  /** The home garage's plan includes multi_site. */
  multiSite: boolean;
};

export type GroupOverviewSite = {
  garageId: string;
  name: string;
  slug: string;
  accent: string | null;
  isHome: boolean;
  isSelected: boolean;
  todayBookings: number;
  openRequests: number;
  revenueMonthPence: number;
  wonBackBookings: number;
  wonBackPence: number;
};

export type GroupOverviewTotals = Pick<GroupOverviewSite, "todayBookings" | "openRequests" | "revenueMonthPence" | "wonBackBookings" | "wonBackPence">;

export type GroupReportSite = { garageId: string; name: string; isHome: boolean; bookings: number; revenuePence: number };

export type GroupReportRange = { from: string; to: string };

/** The longest report range group_report() accepts (inclusive days). */
export const GROUP_REPORT_MAX_DAYS = 366;

function count(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

type Row = Record<string, unknown>;

export function toGroupSummary(row: Row | null | undefined, selectedGarageId: string): GroupSummary {
  return {
    groupId: typeof row?.group_id === "string" ? row.group_id : null,
    groupName: typeof row?.group_name === "string" ? row.group_name : null,
    homeGarageId: typeof row?.home_garage_id === "string" ? row.home_garage_id : selectedGarageId,
    isHome: row?.is_home !== false,
    siteCount: Math.max(1, count(row?.site_count)),
    visibleSites: Math.max(1, count(row?.visible_sites)),
    canAddSites: row?.can_add_sites === true,
    multiSite: row?.multi_site === true,
  };
}

export function toOverviewSite(row: Row): GroupOverviewSite {
  return {
    garageId: String(row.garage_id),
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    accent: typeof row.accent === "string" ? row.accent : null,
    isHome: row.is_home === true,
    isSelected: row.is_selected === true,
    todayBookings: count(row.today_bookings),
    openRequests: count(row.open_requests),
    revenueMonthPence: count(row.revenue_month_pence),
    wonBackBookings: count(row.won_back_bookings),
    wonBackPence: count(row.won_back_pence),
  };
}

export function toReportSite(row: Row): GroupReportSite {
  return {
    garageId: String(row.garage_id),
    name: String(row.name ?? ""),
    isHome: row.is_home === true,
    bookings: count(row.bookings),
    revenuePence: count(row.revenue_pence),
  };
}

export function overviewTotals(sites: GroupOverviewSite[]): GroupOverviewTotals {
  return sites.reduce<GroupOverviewTotals>(
    (sum, site) => ({
      todayBookings: sum.todayBookings + site.todayBookings,
      openRequests: sum.openRequests + site.openRequests,
      revenueMonthPence: sum.revenueMonthPence + site.revenueMonthPence,
      wonBackBookings: sum.wonBackBookings + site.wonBackBookings,
      wonBackPence: sum.wonBackPence + site.wonBackPence,
    }),
    { todayBookings: 0, openRequests: 0, revenueMonthPence: 0, wonBackBookings: 0, wonBackPence: 0 },
  );
}

export function reportTotals(sites: GroupReportSite[]): { bookings: number; revenuePence: number } {
  return sites.reduce((sum, site) => ({ bookings: sum.bookings + site.bookings, revenuePence: sum.revenuePence + site.revenuePence }), { bookings: 0, revenuePence: 0 });
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The report range from the query string (`from`, `to`, `YYYY-MM-DD`): this month to date by default;
 * swapped when back to front; cut to GROUP_REPORT_MAX_DAYS ending at `to`.
 */
export function parseReportRange(input: { from?: unknown; to?: unknown }, todayKey: string): GroupReportRange {
  let from = parseDateKey(input.from) ?? monthStart(todayKey);
  let to = parseDateKey(input.to) ?? todayKey;
  if (to < from) [from, to] = [to, from];
  if (daysBetween(from, to) > GROUP_REPORT_MAX_DAYS - 1) from = addDays(to, -(GROUP_REPORT_MAX_DAYS - 1));
  return { from, to };
}

/** Sites beyond the first: what the group pays extra for. */
export function extraSites(siteCount: number): number {
  return Math.max(0, Math.trunc(siteCount) - 1);
}

/** "Each extra site: Price to be confirmed" while PLAN_EXTRA_SITE_PRICE_PENCE is unset. */
export function extraSitePriceLine(pricePence: number | null): string {
  return `Each extra site: ${formatPlanPrice(pricePence)}`;
}

/** "2 extra sites", "No extra sites". */
export function extraSitesLabel(count: number): string {
  if (count <= 0) return "No extra sites";
  return count === 1 ? "1 extra site" : `${count} extra sites`;
}

function pounds(pence: number): string {
  const whole = Math.trunc(pence);
  return `${Math.trunc(whole / 100)}.${String(Math.abs(whole % 100)).padStart(2, "0")}`;
}

/** Spreadsheet formula injection guard (same rule as the invoice export). */
function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** CSV of the group report: one row per site plus a total row. UTF-8 with BOM, CRLF. */
export function groupReportCsv(sites: GroupReportSite[], range: GroupReportRange): string {
  const totals = reportTotals(sites);
  const rows = [
    ["Site", "From", "To", "Bookings", "Revenue GBP"],
    ...sites.map((site) => [safeText(site.name), range.from, range.to, String(site.bookings), pounds(site.revenuePence)]),
    ["All sites", range.from, range.to, String(totals.bookings), pounds(totals.revenuePence)],
  ];
  return `﻿${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function groupReportFileName(range: GroupReportRange): string {
  return `Group-report-${range.from}-to-${range.to}.csv`;
}
