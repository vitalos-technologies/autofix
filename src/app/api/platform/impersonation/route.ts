import { cookies } from "next/headers";
import { json, readJson, UUID_PATTERN, withPlatformAdmin } from "@/lib/platform/api";
import {
  cleanReason,
  IMPERSONATION_COOKIE,
  IMPERSONATION_COOKIE_OPTIONS,
  IMPERSONATION_MAX_MINUTES,
  IMPERSONATION_MIN_MINUTES,
  IMPERSONATION_MINUTES,
} from "@/lib/platform/policy";
import { currentImpersonation, endImpersonation, startImpersonation } from "@/lib/platform/store";

/** GET /api/platform/impersonation — the caller's open support session, or null. */
export async function GET(request: Request) {
  return withPlatformAdmin(request, async (admin) => json({ impersonation: await currentImpersonation(admin.client) }));
}

/** POST /api/platform/impersonation {garageId, reason, minutes?} — starts a read-only, logged session (5–60 min). */
export async function POST(request: Request) {
  return withPlatformAdmin(request, async (admin) => {
    const body = await readJson(request);
    const garageId = typeof body?.garageId === "string" && UUID_PATTERN.test(body.garageId) ? body.garageId.toLowerCase() : null;
    const reason = cleanReason(body?.reason);
    const minutes = body?.minutes === undefined ? IMPERSONATION_MINUTES : Number(body.minutes);
    if (!garageId || !reason || !Number.isInteger(minutes) || minutes < IMPERSONATION_MIN_MINUTES || minutes > IMPERSONATION_MAX_MINUTES) {
      return json({ error: "INVALID_REQUEST" }, 422);
    }
    const impersonation = await startImpersonation(admin.client, garageId, reason, minutes);
    (await cookies()).set(IMPERSONATION_COOKIE, "1", IMPERSONATION_COOKIE_OPTIONS);
    return json({ impersonation }, 201);
  }, { mutation: true });
}

/** DELETE /api/platform/impersonation — ends the caller's session. */
export async function DELETE(request: Request) {
  return withPlatformAdmin(request, async (admin) => {
    const ended = await endImpersonation(admin.client);
    (await cookies()).set(IMPERSONATION_COOKIE, "", { ...IMPERSONATION_COOKIE_OPTIONS, maxAge: 0 });
    return json({ ended });
  });
}
