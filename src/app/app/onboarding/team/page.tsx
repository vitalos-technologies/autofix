import type { Metadata } from "next";
import { buttonClass } from "@/components/admin-ui/styles";
import { SubmitButton } from "@/components/admin-ui/submit-button";
import { Notice } from "@/components/onboarding/field";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import { InviteForm } from "@/components/team/invite-form";
import { PendingInviteList, TEAM_FLASH } from "@/components/team/team-lists";
import { listPendingInvites } from "@/lib/team/server";
import { finishOnboardingAction } from "../actions";
import { requireOnboardingOwner } from "../context";

export const metadata: Metadata = { title: "Invite your team" };

/** Step 6: invite staff (optional), then go live. */
export default async function OnboardingTeamPage({ searchParams }: { searchParams: Promise<{ error?: string; team?: string }> }) {
  const admin = await requireOnboardingOwner(ONBOARDING_PATHS.team);
  const { error, team } = await searchParams;
  const invites = await listPendingInvites(admin.client);
  const flash = team ? TEAM_FLASH[team] : undefined;
  return (
    <OnboardingFrame step={6} title="Invite your team" description="Add the people who work with you. They get an email with a link to join. You can skip this and do it later in Settings.">
      {flash ? <Notice tone={flash.tone} role={flash.tone === "error" ? "alert" : "status"}>{flash.text}</Notice> : null}
      <section aria-labelledby="invite-heading" className="flex flex-col gap-4 rounded-card border border-grey-200 bg-white p-5">
        <h2 id="invite-heading" className="m-0 text-[17px] font-bold text-navy-950">Invite someone</h2>
        <InviteForm />
      </section>
      <section aria-labelledby="invites-heading" className="flex flex-col gap-2 rounded-card border border-grey-200 bg-white p-5">
        <h2 id="invites-heading" className="m-0 text-[17px] font-bold text-navy-950">Waiting to join</h2>
        <PendingInviteList invites={invites} from={ONBOARDING_PATHS.team} />
      </section>
      {error === "finish_failed" ? <Notice tone="error" role="alert">Your booking page could not be put live. Try again.</Notice> : null}
      <form action={finishOnboardingAction}>
        <SubmitButton className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>Finish and go live</SubmitButton>
      </form>
    </OnboardingFrame>
  );
}
