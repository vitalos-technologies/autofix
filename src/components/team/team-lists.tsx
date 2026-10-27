import { buttonClass } from "@/components/admin-ui/styles";
import { inputClass } from "@/components/onboarding/field";
import { ROLE_LABELS } from "@/lib/signup/schema";
import { changeMemberRoleAction, removeMemberAction, revokeInviteAction } from "@/lib/team/actions";
import type { PendingInvite, TeamMember } from "@/lib/team/server";
import type { GarageRole } from "@/lib/tenancy/admin";
import { ResendInviteButton } from "./resend-invite-button";

const ALL_ROLES: GarageRole[] = ["owner", "manager", "technician", "front_desk"];
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

/** Members with (for owners) a role select and Remove. The last owner is protected by the database. */
export function MemberList({ members, canManage, from }: { members: TeamMember[]; canManage: boolean; from: string }) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-grey-200 p-0">
      {members.map((member) => (
        <li key={member.userId} className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold text-navy-950">{member.displayName}{member.isSelf ? " (you)" : ""}</span>
            {member.email ? <span className="text-[13px] break-all text-grey-600">{member.email}</span> : null}
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-end gap-2">
              <form action={changeMemberRoleAction} className="flex items-end gap-2">
                <input type="hidden" name="userId" value={member.userId} />
                <input type="hidden" name="from" value={from} />
                <label className="sr-only" htmlFor={`role-${member.userId}`}>Role for {member.displayName}</label>
                <select id={`role-${member.userId}`} name="role" defaultValue={member.role} className={`${inputClass} min-h-11 w-auto`}>
                  {ALL_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                </select>
                <button type="submit" className={buttonClass("secondary", "sm")} aria-label={`Save role for ${member.displayName}`}>Save</button>
              </form>
              <form action={removeMemberAction}>
                <input type="hidden" name="userId" value={member.userId} />
                <input type="hidden" name="from" value={from} />
                <button type="submit" className={buttonClass("ghost", "sm", "text-[#b91c1c]")} aria-label={`Remove ${member.displayName} from the team`}>Remove</button>
              </form>
            </div>
          ) : (
            <span className="w-fit rounded-full bg-grey-100 px-3 py-1 text-[13px] font-semibold text-grey-700">{ROLE_LABELS[member.role]}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Open invites with Send again and Withdraw. */
export function PendingInviteList({ invites, from }: { invites: PendingInvite[]; from: string }) {
  if (!invites.length) return <p className="m-0 text-[14px] text-grey-600">No invites waiting.</p>;
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-grey-200 p-0">
      {invites.map((invite) => (
        <li key={invite.id} className="flex flex-col gap-3 py-3.5">
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold break-all text-navy-950">{invite.email}</span>
            <span className="text-[13px] text-grey-600">
              {ROLE_LABELS[invite.role]} · {invite.expired ? "Expired" : `Expires ${dateFormat.format(new Date(invite.expiresAt))}`}
            </span>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <ResendInviteButton inviteId={invite.id} email={invite.email} />
            <form action={revokeInviteAction}>
              <input type="hidden" name="inviteId" value={invite.id} />
              <input type="hidden" name="from" value={from} />
              <button type="submit" className={buttonClass("ghost", "sm", "text-[#b91c1c]")} aria-label={`Withdraw the invite to ${invite.email}`}>Withdraw</button>
            </form>
          </div>
        </li>
      ))}
    </ul>
  );
}

export const TEAM_FLASH: Record<string, { tone: "success" | "error"; text: string }> = {
  invite_revoked: { tone: "success", text: "Invite withdrawn. Its link no longer works." },
  role_changed: { tone: "success", text: "Role saved." },
  member_removed: { tone: "success", text: "Removed from the team." },
  last_owner: { tone: "error", text: "A garage needs at least one owner. Make someone else owner first." },
  not_allowed: { tone: "error", text: "Only the garage owner can change roles and remove people." },
  mfa: { tone: "error", text: "Verify your sign-in with your authenticator app first." },
  failed: { tone: "error", text: "That change could not be saved. Try again." },
};
