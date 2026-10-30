import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass, textLinkClass } from "@/components/admin-ui/styles";
import { Notice } from "@/components/onboarding/field";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { resolvePlacesMode } from "@/lib/places/provider";
import { getSignupSession, onboardingBookingUrl } from "@/lib/signup/server";
import { signOutOfSignupAction } from "../actions";
import { ContinueForm } from "./continue-form";
import { GarageWizard } from "./garage-wizard";

export const metadata: Metadata = { title: "Set up your garage" };

/**
 * Sign-up steps 1–2 (signed in, email confirmed): find or enter the garage, choose the free
 * booking link, create the garage. Someone who already works for another garage can add one here.
 */
export default async function SignupGaragePage({ searchParams }: { searchParams: Promise<{ link?: string }> }) {
  const { link } = await searchParams;
  const session = await getSignupSession();
  if (!session) {
    return (
      <OnboardingFrame eyebrow="Set up your garage" title="Sign in to continue" description="Use the email and password you signed up with.">
        {link === "invalid" ? <Notice tone="warning" role="status">That confirmation link has been used or has expired. If you already confirmed your email, sign in to carry on.</Notice> : null}
        <ContinueForm />
        <p className="m-0 text-[14px] text-grey-600">
          New to Pitline? <Link href="/signup" className={textLinkClass}>Create an account</Link>
        </p>
      </OnboardingFrame>
    );
  }

  const signOut = (
    <form action={signOutOfSignupAction}>
      <button type="submit" className={buttonClass("ghost", "sm")}>Sign out</button>
    </form>
  );

  if (!session.confirmed) {
    return (
      <OnboardingFrame eyebrow="Set up your garage" title="Confirm your email first" headerAction={signOut}>
        <Notice tone="info">Open the link we sent to your email address, then come back here.</Notice>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame headerAction={signOut}>
      <GarageWizard
        placesEnabled={resolvePlacesMode() !== "off"}
        linkTemplate={onboardingBookingUrl({ slug: "__slug__" })}
        ownerEmail={session.user.email ?? ""}
      />
    </OnboardingFrame>
  );
}
