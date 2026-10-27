import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { buttonClass, textLinkClass } from "@/components/admin-ui/styles";
import { Notice } from "@/components/onboarding/field";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { INVITE_COOKIE, isInviteToken } from "@/lib/signup/invite-token";
import { ROLE_LABELS } from "@/lib/signup/schema";
import { getSignupSession } from "@/lib/signup/server";
import { previewInvite } from "@/lib/team/server";
import { signOutForInviteAction } from "./actions";
import { AcceptInviteForm, CreateAccountAndAcceptForm, SignInAndAcceptForm } from "./invite-forms";

export const metadata: Metadata = { title: "Join your garage", referrer: "no-referrer" };

/** Accept a staff invite: works signed in (right account), with an existing account, or a new one. */
export default async function InvitePage() {
  const token = (await cookies()).get(INVITE_COOKIE)?.value;
  const preview = isInviteToken(token) ? await previewInvite(token) : null;

  if (!preview || preview.status === "used") {
    return (
      <OnboardingFrame eyebrow="Team invite" title={preview ? "This invite has been used" : "This invite link isn't valid"} description="Invites work once and for 7 days. Ask the garage owner or manager to send you a new one.">
        <p className="m-0 text-[14px] text-grey-600">
          Already joined? <Link href="/app/login" className={textLinkClass}>Sign in</Link>
        </p>
      </OnboardingFrame>
    );
  }
  if (preview.status === "expired") {
    return (
      <OnboardingFrame eyebrow="Team invite" title="This invite has expired" description={`Ask ${preview.garageName} to send it again from Settings, Team.`}>
        <span />
      </OnboardingFrame>
    );
  }

  const session = await getSignupSession();
  const role = ROLE_LABELS[preview.role];
  const intro = `${preview.garageName} has invited you to join their team on Autofix as ${role === "Front desk" ? "front desk" : role.toLowerCase()}.`;
  const sessionEmail = session?.user.email?.toLowerCase();

  return (
    <OnboardingFrame eyebrow="Team invite" title={`Join ${preview.garageName}`} description={intro}>
      {session && sessionEmail === preview.email ? (
        <AcceptInviteForm garageName={preview.garageName} />
      ) : session ? (
        <div className="flex flex-col gap-3">
          <Notice tone="warning">This invite is for {preview.email}. You&apos;re signed in with another account.</Notice>
          <form action={signOutForInviteAction}>
            <button type="submit" className={buttonClass("secondary", "md", "w-full")}>Sign out and continue</button>
          </form>
        </div>
      ) : preview.accountExists ? (
        <SignInAndAcceptForm email={preview.email} />
      ) : (
        <CreateAccountAndAcceptForm email={preview.email} />
      )}
    </OnboardingFrame>
  );
}
