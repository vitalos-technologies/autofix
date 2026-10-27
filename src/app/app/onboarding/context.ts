import "server-only";

import { redirect } from "next/navigation";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import { getAdminContext, type AdminContext } from "@/lib/tenancy/admin";

/**
 * The new garage's owner for an onboarding step (P4.4), on the selected garage (`af_garage`,
 * set when the garage was created). Steps after Security need MFA verified in this session
 * (A59: owners need it for setup changes); a remembered device is not enough here.
 */
export async function requireOnboardingOwner(path: string, options: { mfa: boolean } = { mfa: true }): Promise<AdminContext> {
  const admin = await getAdminContext({ requireMfa: false });
  if (!admin) redirect("/signup/garage");
  if (admin.role !== "owner") redirect("/app");
  if (admin.mfaState === "challenge_required") redirect(`/app/mfa?returnTo=${encodeURIComponent(path)}`);
  if (options.mfa && !admin.mfaVerified) redirect(ONBOARDING_PATHS.security);
  return admin;
}
