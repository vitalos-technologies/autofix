import type { Metadata } from "next";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { textLinkClass } from "@/components/admin-ui/styles";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";

export const metadata: Metadata = { title: "Check your email" };

/** After sign-up: the confirmation link continues at /signup/garage. The address is not repeated here (nothing personal in the page or URL). */
export default function CheckEmailPage() {
  return (
    <OnboardingFrame eyebrow="Almost there" title="Check your email" description="We've sent you a link to confirm your email address. Open it on this device to set up your garage.">
      <div className="flex items-start gap-3 rounded-card border border-grey-200 bg-white p-5">
        <MailCheck size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
        <div className="flex flex-col gap-2 text-[15px] leading-6">
          <p className="m-0 font-semibold text-navy-950">The link works for one hour.</p>
          <p className="m-0 text-grey-600">Can&apos;t see it? Check your spam folder, or sign up again with the right address.</p>
        </div>
      </div>
      <p className="m-0 text-[14px] text-grey-600">
        Already confirmed? <Link href="/signup/garage" className={textLinkClass}>Continue set-up</Link>
      </p>
    </OnboardingFrame>
  );
}
