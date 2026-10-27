import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { textLinkClass } from "@/components/admin-ui/styles";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { getSignupSession } from "@/lib/signup/server";
import { AccountForm } from "./account-form";

export const metadata: Metadata = { title: "Create your garage account" };

/** Sign-up step 0 (admin host): the owner's account. Signed-in, confirmed users carry on with their garage. */
export default async function SignupPage() {
  const session = await getSignupSession();
  if (session?.confirmed) redirect("/signup/garage");
  return (
    <OnboardingFrame
      eyebrow="Get started"
      title="Put your garage online"
      description="Create your account, then set up your booking page, services and team. It takes about ten minutes."
    >
      <AccountForm />
      <div className="flex flex-col gap-1 text-[14px] text-grey-600">
        <p className="m-0">
          Already started setting up? <Link href="/signup/garage" className={textLinkClass}>Continue set-up</Link>
        </p>
        <p className="m-0">
          Already on Autofix? <Link href="/app/login" className={textLinkClass}>Sign in</Link>
        </p>
      </div>
    </OnboardingFrame>
  );
}
