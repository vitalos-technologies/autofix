import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/components/admin-ui/styles";
import { DpaAcceptance } from "@/components/legal/dpa-acceptance";
import { Notice } from "@/components/onboarding/field";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import { loadDpaStatus } from "@/lib/legal/agreements";
import { requireOnboardingOwner } from "../context";

export const metadata: Metadata = { title: "Data processing agreement" };

/** Step 5: the DPA (P4.9's DpaAcceptance + acceptDpaAction). Sign-up requires it (A72). */
export default async function OnboardingAgreementPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const admin = await requireOnboardingOwner(ONBOARDING_PATHS.agreement);
  const { error } = await searchParams;
  const status = await loadDpaStatus(admin.client, admin.garage.id);
  return (
    <OnboardingFrame
      step={5}
      width="wide"
      title="Your data agreement"
      description="Vitalos stores your customers' details for you. This agreement sets out how. Read it and accept it as the garage owner."
    >
      {error === "dpa_required" && !status.current ? <Notice tone="error" role="alert">Accept the agreement to put your booking page live.</Notice> : null}
      <DpaAcceptance garage={admin.garage} status={status} canAccept />
      {status.current ? (
        <Link href={ONBOARDING_PATHS.team} className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
          Continue to your team
        </Link>
      ) : null}
    </OnboardingFrame>
  );
}
