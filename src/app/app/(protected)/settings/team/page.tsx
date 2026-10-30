import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader, Panel } from "@/components/admin-ui";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice } from "@/components/onboarding/field";
import { InviteForm } from "@/components/team/invite-form";
import { MemberList, PendingInviteList, TEAM_FLASH } from "@/components/team/team-lists";
import { canManageInvites, canManageMembers, listPendingInvites, listTeam } from "@/lib/team/server";
import { getAdminContext } from "@/lib/tenancy/admin";

export const metadata: Metadata = { title: "Team" };

const PATH = "/app/settings/team";

/**
 * Settings · Team (P4.4): members and roles, invites. Everyone sees the team; owners and managers
 * invite, re-send and withdraw invites; only owners change roles or remove people. Changes need
 * MFA verified in this session.
 */
export default async function TeamSettingsPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const { team } = await searchParams;
  const flash = team ? TEAM_FLASH[team] : undefined;
  const manageInvites = canManageInvites(admin.role);
  const [members, invites] = await Promise.all([
    listTeam(admin.client),
    manageInvites ? listPendingInvites(admin.client) : Promise.resolve([]),
  ]);
  const needsStepUp = manageInvites && !admin.mfaVerified;

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Settings" title="Team" description={`Who works at ${admin.garage.name} on Pitline, and what they can do.`} />
      {flash ? <Notice tone={flash.tone} role={flash.tone === "error" ? "alert" : "status"}>{flash.text}</Notice> : null}
      {needsStepUp ? (
        <Notice tone="warning">
          To change the team, verify your sign-in first.{" "}
          <Link href={`/app/mfa?returnTo=${encodeURIComponent(PATH)}&stepUp=1`} className="underline">Verify now</Link>
        </Notice>
      ) : null}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Panel id="members" title="Members" count={members.length} countLabel="members">
          <MemberList members={members} canManage={canManageMembers(admin.role) && admin.mfaVerified} from={PATH} />
        </Panel>
        {manageInvites ? (
          <div className="flex min-w-0 flex-col gap-5">
            <Panel id="invite" title="Invite someone">
              {admin.mfaVerified ? <InviteForm /> : <p className="m-0 text-[14px] text-grey-600">Verify your sign-in to send invites.</p>}
            </Panel>
            <Panel id="invites" title="Waiting to join" count={invites.length} countLabel="invites">
              <PendingInviteList invites={invites} from={PATH} />
            </Panel>
          </div>
        ) : (
          <Panel title="Invites">
            <p className="m-0 text-[14px] text-grey-600">Ask the garage owner or a manager to invite someone.</p>
            <Link href="/app" className={buttonClass("secondary", "md", "w-fit")}>Back to today</Link>
          </Panel>
        )}
      </div>
    </div>
  );
}
