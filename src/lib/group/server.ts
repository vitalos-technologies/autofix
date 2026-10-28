import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getBillingProvider, type BillingProvider } from "@/lib/billing";
import { loadSubscription } from "@/lib/billing/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  toGroupSummary,
  toOverviewSite,
  toReportSite,
  type GroupOverviewSite,
  type GroupReportRange,
  type GroupReportSite,
  type GroupSummary,
} from "./report";

// Multi-site (P5.9). Every group read goes through the member's RLS client (`admin.client`, which
// sends the SELECTED garage as x-garage-id); the SQL functions pick the group from that garage and
// aggregate only sites the member is owner or manager of. No garage id from the request is used to
// read. The service role is used only to tell billing how many extra sites there are.

export class GroupDataError extends Error {
  constructor(readonly code: "PLAN_REQUIRED" | "FORBIDDEN" | "UNAVAILABLE") {
    super(code);
    this.name = "GroupDataError";
  }
}

type DatabaseError = { code?: string | null; message?: string | null } | null;

function groupError(error: DatabaseError): GroupDataError {
  if (error?.message?.startsWith("PLAN_REQUIRED")) return new GroupDataError("PLAN_REQUIRED");
  if (error?.code === "42501") return new GroupDataError("FORBIDDEN");
  return new GroupDataError("UNAVAILABLE");
}

/** The selected garage's group (or a group of one). Null for members who aren't owners or managers. */
export async function loadGroupSummary(client: SupabaseClient, selectedGarageId: string): Promise<GroupSummary | null> {
  const { data, error } = await client.rpc("group_summary");
  if (error) return null;
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : (data as Record<string, unknown> | null);
  return toGroupSummary(row, selectedGarageId);
}

/** Whether the selected garage is in a group (the switcher's "Group overview" link). Never throws. */
export async function selectedGarageInGroup(client: SupabaseClient): Promise<boolean> {
  const { count, error } = await client.from("garage_group_sites").select("garage_id", { count: "exact", head: true });
  return !error && (count ?? 0) > 0;
}

export async function loadGroupOverview(client: SupabaseClient, now: Date): Promise<GroupOverviewSite[]> {
  const { data, error } = await client.rpc("group_overview", { p_now: now.toISOString() });
  if (error) throw groupError(error);
  return ((data ?? []) as Record<string, unknown>[]).map(toOverviewSite);
}

export async function loadGroupReport(client: SupabaseClient, range: GroupReportRange): Promise<GroupReportSite[]> {
  const { data, error } = await client.rpc("group_report", { p_from: range.from, p_to: range.to });
  if (error) throw groupError(error);
  return ((data ?? []) as Record<string, unknown>[]).map(toReportSite);
}

export type ExtraSitesSync = { ok: boolean; extraSites: number };

/**
 * Tells the billing provider how many sites beyond the first the group pays for, then records the
 * count on the home garage's subscription (service role). The home garage id comes from
 * group_add_site()/group_remove_site(), never from the form. With the mock provider this only records.
 */
export async function syncExtraSites(
  input: { homeGarageId: string; extraSites: number; actorId: string },
  provider: BillingProvider = getBillingProvider(),
): Promise<ExtraSitesSync> {
  const subscription = await loadSubscription(input.homeGarageId);
  const told = await provider.setExtraSites({ garageId: input.homeGarageId, subscriptionRef: subscription?.subscription_ref ?? null, count: input.extraSites });
  if (!told.ok) {
    await recordAdminAudit(input.homeGarageId, {
      actorId: input.actorId,
      action: "group.billing_failed",
      entityType: "garage",
      entityId: input.homeGarageId,
      detail: { provider: provider.kind, extra_sites: input.extraSites, code: told.code ?? null },
    });
    console.info(JSON.stringify({ scope: "group", event: "extra_sites", provider: provider.kind, outcome: "provider_failed" }));
    return { ok: false, extraSites: input.extraSites };
  }
  const service = createAdminClient();
  if (!service) return { ok: false, extraSites: input.extraSites };
  const { data, error } = await service.rpc("record_group_extra_sites", { p_home_garage_id: input.homeGarageId, p_provider: provider.kind });
  if (error) {
    console.info(JSON.stringify({ scope: "group", event: "extra_sites", provider: provider.kind, outcome: "record_failed" }));
    return { ok: false, extraSites: input.extraSites };
  }
  return { ok: true, extraSites: typeof data === "number" ? data : input.extraSites };
}
