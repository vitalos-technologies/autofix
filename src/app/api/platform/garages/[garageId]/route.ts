import { json, notFoundJson, readJson, UUID_PATTERN, withPlatformAdmin } from "@/lib/platform/api";
import { cleanReason, isGaragePlan, isGarageStatus } from "@/lib/platform/policy";
import { getGarage, updateGarage } from "@/lib/platform/store";

type Context = { params: Promise<{ garageId: string }> };

/** GET /api/platform/garages/:id — one garage with counts, domains and support sessions. */
export async function GET(request: Request, { params }: Context) {
  const { garageId } = await params;
  return withPlatformAdmin(request, async (admin) => {
    if (!UUID_PATTERN.test(garageId)) return notFoundJson();
    const garage = await getGarage(admin.client, garageId);
    return garage ? json({ garage }) : notFoundJson();
  });
}

/** PATCH /api/platform/garages/:id {plan?, status?, reason} — audited in the garage's log and the platform log. */
export async function PATCH(request: Request, { params }: Context) {
  const { garageId } = await params;
  return withPlatformAdmin(request, async (admin) => {
    if (!UUID_PATTERN.test(garageId)) return notFoundJson();
    const body = await readJson(request);
    const reason = cleanReason(body?.reason);
    const plan = body?.plan ?? null;
    const status = body?.status ?? null;
    if (!body || !reason || (plan !== null && !isGaragePlan(plan)) || (status !== null && !isGarageStatus(status)) || (plan === null && status === null)) {
      return json({ error: "INVALID_REQUEST" }, 422);
    }
    return json({ garage: await updateGarage(admin.client, garageId, { plan, status, reason }) });
  }, { mutation: true });
}
