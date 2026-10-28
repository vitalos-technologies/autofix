import { json, withPlatformAdmin } from "@/lib/platform/api";
import { isGaragePlanFilter, isGarageStatus } from "@/lib/platform/policy";
import { listGarages } from "@/lib/platform/store";

/** GET /api/platform/garages?q=&status=&plan=&page= — the garages list (25 a page). Platform admins only. */
export async function GET(request: Request) {
  return withPlatformAdmin(request, async (admin) => {
    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    const plan = params.get("plan");
    if ((status && !isGarageStatus(status)) || (plan && !isGaragePlanFilter(plan))) return json({ error: "INVALID_FILTER" }, 422);
    const result = await listGarages(admin.client, {
      search: params.get("q")?.slice(0, 80) ?? undefined,
      status: status && isGarageStatus(status) ? status : undefined,
      plan: plan && isGaragePlanFilter(plan) ? plan : undefined,
      page: Number.parseInt(params.get("page") ?? "1", 10) || 1,
    });
    return json(result);
  });
}
