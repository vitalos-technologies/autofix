import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice } from "@/components/onboarding/field";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import { requireOnboardingOwner } from "../context";

export const metadata: Metadata = { title: "Secure your account" };

/** Step 3: two-step verification through the existing /app/mfa/enroll flow, then back here. */
export default async function OnboardingSecurityPage() {
  const admin = await requireOnboardingOwner(ONBOARDING_PATHS.security, { mfa: false });
  const enrollHref = `/app/mfa/enroll?returnTo=${encodeURIComponent(ONBOARDING_PATHS.security)}`;
  return (
    <OnboardingFrame
      step={3}
      title="Secure your account"
      description={`${admin.garage.name} is created. Owners change bookings, prices and staff, so your account needs two-step verification with an authenticator app.`}
    >
      {admin.mfaVerified ? (
        <>
          <Notice tone="success" role="status">Two-step verification is on for this account.</Notice>
          <Link href={ONBOARDING_PATHS.services} className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
            Continue to services
          </Link>
        </>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-card border border-grey-200 bg-white p-5">
            <ShieldCheck size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
            <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[15px] leading-6 text-grey-700">
              <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password).</li>
              <li>Scan the QR code on the next screen.</li>
              <li>Enter the 6-digit code, then save your recovery codes.</li>
            </ol>
          </div>
          <Link href={enrollHref} className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
            Set up two-step verification
          </Link>
        </>
      )}
    </OnboardingFrame>
  );
}
