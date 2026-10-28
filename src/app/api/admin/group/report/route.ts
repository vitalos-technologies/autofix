import { recordAdminAudit } from "@/lib/admin/audit";
import { localDateKey } from "@/lib/admin/dates";
import { groupReportCsv, groupReportFileName, parseReportRange } from "@/lib/group/report";
import { GroupDataError, loadGroupReport } from "@/lib/group/server";
import { featureGuard, planRequiredResponse } from "@/lib/plans/server";
import { getAdminContext } from "@/lib/tenancy/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };

/**
 * Group report CSV (P5.9, Pro `multi_site`): bookings and revenue by site over `from`..`to`. The group
 * is the selected garage's group; group_report() reads only sites the member is owner or manager of.
 * 401 signed out, 403 for other roles, 403 PLAN_REQUIRED on Essentials.
 */
export async function GET(request: Request) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return Response.json({ error: "Unauthorised" }, { status: 401, headers: privateHeaders });
  if (admin.role !== "owner" && admin.role !== "manager") {
    return Response.json({ error: "Only owners and managers can export group reports." }, { status: 403, headers: privateHeaders });
  }
  const locked = featureGuard(admin.garage, "multi_site");
  if (locked) return locked;

  const params = new URL(request.url).searchParams;
  const range = parseReportRange({ from: params.get("from"), to: params.get("to") }, localDateKey(new Date(), admin.garage.timezone || "Europe/London"));
  try {
    const sites = await loadGroupReport(admin.client, range);
    await recordAdminAudit(admin.garage.id, {
      actorId: admin.user.id,
      action: "group.report_exported",
      entityType: "group_report",
      entityId: `${range.from}..${range.to}`,
      detail: { sites: sites.length },
    });
    return new Response(groupReportCsv(sites, range), {
      headers: { ...privateHeaders, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${groupReportFileName(range)}"` },
    });
  } catch (error) {
    if (error instanceof GroupDataError && error.code === "PLAN_REQUIRED") return planRequiredResponse("multi_site");
    if (error instanceof GroupDataError && error.code === "FORBIDDEN") return Response.json({ error: "Forbidden" }, { status: 403, headers: privateHeaders });
    console.error("[group-report] Export failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "The report could not be created" }, { status: 500, headers: privateHeaders });
  }
}
