import { redirect } from "next/navigation";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import { requireOnboardingOwner } from "./context";

/** /app/onboarding: the next step for the selected garage. */
export default async function OnboardingIndex() {
  const admin = await requireOnboardingOwner("/app/onboarding", { mfa: false });
  if (admin.garage.status === "active") redirect(ONBOARDING_PATHS.done);
  redirect(admin.mfaVerified ? ONBOARDING_PATHS.services : ONBOARDING_PATHS.security);
}
