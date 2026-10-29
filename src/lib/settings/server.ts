import "server-only";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { recordAdminAudit } from "@/lib/admin/audit";
import { clearSlotCache } from "@/lib/booking-engine/slots";
import { canChangeGarage, canManageSetup, type SetupFormState } from "@/lib/settings/setup";
import { getAdminContext, type AdminContext } from "@/lib/tenancy/admin";

// Shared plumbing for the Setup server actions (P3.4). Every write goes
// through the selected garage's RLS client (`admin.client`, x-garage-id) and
// names `admin.garage.id` explicitly; the garage never comes from the form.

/**
 * The signed-in member for a setup write, with MFA done in this session (a remembered device can read
 * setup but not change it). Signed-out users go to login, members who still owe MFA to the challenge,
 * returning to `returnTo`.
 */
export async function requireSetupContext(returnTo: string): Promise<AdminContext> {
  const admin = await getAdminContext();
  if (admin) return admin;
  const loose = await getAdminContext({ requireMfa: false });
  if (!loose) redirect("/app/login");
  if (loose.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  redirect(`/app/mfa?returnTo=${encodeURIComponent(returnTo)}&stepUp=1`);
}

export const NOT_ALLOWED_MESSAGES = {
  manage: "Only the garage's owners and managers can change this.",
  owner: "Only the garage owner can change this.",
} as const;

/** True when the member's role may make this kind of change (the same split as the RLS policies). */
export function roleAllows(admin: Pick<AdminContext, "role">, level: keyof typeof NOT_ALLOWED_MESSAGES) {
  return level === "owner" ? canChangeGarage(admin.role) : canManageSetup(admin.role);
}

export function stateFor<Field extends string>(
  previous: SetupFormState<Field>,
  next: Omit<SetupFormState<Field>, "seq">,
): SetupFormState<Field> {
  return { seq: previous.seq + 1, ...next };
}

type DatabaseError = { code?: string | null; message?: string | null } | null | undefined;

/** A plain-English message for a failed write. Never includes the database's own text. */
export function databaseProblem(error: DatabaseError, fallback = "That could not be saved. Try again."): string {
  switch (error?.code) {
    case "42501":
      return "You don't have permission to change this.";
    case "23P01":
      return "Those hours overlap with hours that are already saved. Reload the page and try again.";
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
      return "Some of the values can't be saved. Check them and try again.";
    default:
      return fallback;
  }
}

/** After a change that affects which times customers see: drop cached slots and re-render setup and the booking site. */
export function afterSetupChange(garageId: string, paths: string[]) {
  clearSlotCache(garageId);
  for (const path of paths) revalidatePath(path);
  revalidatePath("/_site/[garageId]", "layout");
}

/** Best-effort audit entry for a setup change (the change itself has already been saved). */
export async function auditSetupChange(admin: Pick<AdminContext, "garage" | "user">, action: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}) {
  try {
    await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action, entityType, entityId, detail });
  } catch {
    // The audit log is a record, not a gate, for setup changes.
  }
}
