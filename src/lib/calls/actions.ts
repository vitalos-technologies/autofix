"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getAdminContext } from "@/lib/tenancy/admin";

// "Mark handled" on a missed call (P4.1, Today's "Needs your OK"). Any member
// of the garage may mark its calls handled, as themselves: the RLS client's
// column grant allows only handled_at and handled_by, and the policy requires
// handled_by = the signed-in user. The call id comes from the form; the garage
// always comes from the member's session.

const callIdSchema = z.string().uuid();

export type MarkHandledResult = { ok: true; changed: boolean } | { ok: false; code: "invalid" | "unauthorised" | "unavailable" };

export async function markMissedCallHandled(callId: unknown): Promise<MarkHandledResult> {
  const id = callIdSchema.safeParse(callId);
  if (!id.success) return { ok: false, code: "invalid" };
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return { ok: false, code: "unauthorised" };

  const { data, error } = await admin.client
    .from("calls")
    .update({ handled_at: new Date().toISOString(), handled_by: admin.user.id })
    .eq("garage_id", admin.garage.id)
    .eq("id", id.data)
    .is("handled_at", null)
    .select("id");
  if (error) return { ok: false, code: "unavailable" };
  const changed = (data ?? []).length > 0;
  if (changed) {
    await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "call.handled", entityType: "call", entityId: id.data });
  }
  revalidatePath("/app");
  return { ok: true, changed };
}

/** Form action for the card's "Mark handled" button (hidden field `callId`). */
export async function markMissedCallHandledAction(formData: FormData): Promise<void> {
  await markMissedCallHandled(formData.get("callId"));
}
