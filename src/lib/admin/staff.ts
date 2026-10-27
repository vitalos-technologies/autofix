import "server-only";

import { redirect } from "next/navigation";
import { getAdminContext, type AdminContext } from "@/lib/tenancy/admin";

/**
 * The signed-in member for a server action that changes data. Writes need a verified MFA session
 * (a remembered device is enough to read, not to write), as SOB's booking actions did. The garage
 * is the member's selected garage; actions never take a garage id from the form.
 */
export async function requireStaffWriter(returnTo = "/app"): Promise<AdminContext> {
  const admin = await getAdminContext({ requireMfa: false });
  if (!admin) redirect("/app/login");
  if (admin.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (admin.mfaRequired && !admin.mfaVerified) redirect(`/app/mfa?returnTo=${encodeURIComponent(returnTo)}&stepUp=1`);
  return admin;
}
