import { recordAdminAudit } from "@/lib/admin/audit";
import { DEFAULT_TIME_ZONE, localDateKey } from "@/lib/admin/dates";
import { featureGuard, planRequiredResponse } from "@/lib/plans/server";
import { smsSegmentCostPence } from "@/lib/reports/config";
import { buildReportCsv } from "@/lib/reports/export";
import { RANGE_PROBLEMS, resolveReportRange } from "@/lib/reports/range";
import { ReportLoadError } from "@/lib/reports/server";
import { isReportKind, reportFileName } from "@/lib/reports/shape";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// P5.6: CSV export of one report. GET /api/admin/reports/<kind>?range=last_month (or
// range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD). Owners and managers of the selected garage, Pro
// (advanced_reports); the garage is the session's, never the request's. No customer data in the
// URL or the file name.

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };

function problem(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: privateHeaders });
}

export async function GET(request: Request, { params }: { params: Promise<{ report: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return problem(401, "UNAUTHORISED", "Sign in to export reports.");
  const { report } = await params;
  if (!isReportKind(report)) return problem(404, "NOT_FOUND", "There is no such report.");

  const locked = featureGuard(admin.garage, "advanced_reports");
  if (locked) return locked;
  if (!canManageSetup(admin.role)) return problem(403, "NOT_ALLOWED", "Reports are for the garage's owners and managers.");

  const search = new URL(request.url).searchParams;
  const today = localDateKey(new Date(), admin.garage.timezone || DEFAULT_TIME_ZONE);
  const { range, problem: rangeProblem } = resolveReportRange({ range: search.get("range"), from: search.get("from"), to: search.get("to") }, today);
  if (rangeProblem) return problem(400, "INVALID_RANGE", RANGE_PROBLEMS[rangeProblem]);

  try {
    const { csv, rows } = await buildReportCsv(admin.client, report, range, smsSegmentCostPence(process.env));
    await recordAdminAudit(admin.garage.id, {
      actorId: admin.user.id,
      action: "report.exported",
      entityType: "report",
      entityId: report,
      detail: { from: range.from, to: range.to, rows },
    });
    return new Response(csv, {
      headers: {
        ...privateHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${reportFileName(report, range)}"`,
      },
    });
  } catch (error) {
    if (error instanceof ReportLoadError) {
      if (error.reason === "plan_required") return planRequiredResponse("advanced_reports");
      if (error.reason === "not_allowed") return problem(403, "NOT_ALLOWED", "Reports are for the garage's owners and managers.");
      if (error.reason === "invalid_range") return problem(400, "INVALID_RANGE", RANGE_PROBLEMS.too_long);
    }
    console.error("[reports] export failed", report, error instanceof Error ? error.name : "unknown");
    return problem(500, "EXPORT_FAILED", "The report could not be exported. Try again.");
  }
}
