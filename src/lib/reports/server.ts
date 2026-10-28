import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlanRequiredDatabaseError } from "@/lib/plans/entitlements";
import type { ReportRange } from "./range";
import {
  campaignRoiFromRow,
  hoursFromRows,
  reminderRoiFromRows,
  revenueRowsFromService,
  revenueRowsFromTechnician,
  utilisationFromRows,
  type CampaignRoi,
  type HoursRow,
  type ReminderRoiRow,
  type RevenueRow,
  type UtilisationDay,
} from "./shape";

// Report loading (P5.6). Every call goes through the admin's RLS client, so the database picks the
// garage (current_garage_id(): the member's selected garage), checks the role (owners and
// managers) and the plan (advanced_reports). Nothing here takes a garage id.

export class ReportLoadError extends Error {
  constructor(
    readonly reason: "plan_required" | "not_allowed" | "invalid_range" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "ReportLoadError";
  }
}

type RpcError = { code?: string | null; message?: string | null } | null;

function failure(name: string, error: RpcError): ReportLoadError {
  if (isPlanRequiredDatabaseError(error)) return new ReportLoadError("plan_required", "PLAN_REQUIRED");
  if (error?.code === "42501") return new ReportLoadError("not_allowed", "NOT_ALLOWED");
  if (error?.code === "22023") return new ReportLoadError("invalid_range", "INVALID_RANGE");
  return new ReportLoadError("failed", `${name} failed`);
}

async function call(client: SupabaseClient, name: string, range: Pick<ReportRange, "from" | "to">): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.rpc(name, { p_from: range.from, p_to: range.to });
  if (error) throw failure(name, error);
  return (data ?? []) as Record<string, unknown>[];
}

export async function loadRevenueByService(client: SupabaseClient, range: Pick<ReportRange, "from" | "to">): Promise<RevenueRow[]> {
  return revenueRowsFromService(await call(client, "report_revenue_by_service", range));
}

export async function loadRevenueByTechnician(client: SupabaseClient, range: Pick<ReportRange, "from" | "to">): Promise<RevenueRow[]> {
  return revenueRowsFromTechnician(await call(client, "report_revenue_by_technician", range));
}

export async function loadUtilisation(client: SupabaseClient, range: Pick<ReportRange, "from" | "to">): Promise<UtilisationDay[]> {
  return utilisationFromRows(await call(client, "report_bay_utilisation", range));
}

export async function loadHours(client: SupabaseClient, range: Pick<ReportRange, "from" | "to">): Promise<HoursRow[]> {
  return hoursFromRows(await call(client, "report_hours", range));
}

export async function loadReminderRoi(client: SupabaseClient, range: Pick<ReportRange, "from" | "to">): Promise<ReminderRoiRow[]> {
  return reminderRoiFromRows(await call(client, "report_reminder_roi", range));
}

/** Campaigns (P5.5) are optional: report_campaign_roi() says `available: false` until they exist. */
export async function loadCampaignRoi(client: SupabaseClient, range: Pick<ReportRange, "from" | "to">): Promise<CampaignRoi> {
  return campaignRoiFromRow((await call(client, "report_campaign_roi", range))[0]);
}

export type AllReports = {
  revenueByService: RevenueRow[];
  revenueByTechnician: RevenueRow[];
  utilisation: UtilisationDay[];
  hours: HoursRow[];
  reminderRoi: ReminderRoiRow[];
  campaignRoi: CampaignRoi;
};

export async function loadAllReports(client: SupabaseClient, range: Pick<ReportRange, "from" | "to">): Promise<AllReports> {
  const [revenueByService, revenueByTechnician, utilisation, hours, reminderRoi, campaignRoi] = await Promise.all([
    loadRevenueByService(client, range),
    loadRevenueByTechnician(client, range),
    loadUtilisation(client, range),
    loadHours(client, range),
    loadReminderRoi(client, range),
    loadCampaignRoi(client, range),
  ]);
  return { revenueByService, revenueByTechnician, utilisation, hours, reminderRoi, campaignRoi };
}
