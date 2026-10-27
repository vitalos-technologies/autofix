"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auditSetupChange } from "@/lib/settings/server";
import { parseInviteForm, type FieldErrors, type InviteField, type InviteRole } from "@/lib/signup/schema";
import { getAdminContext, type AdminContext, type GarageRole } from "@/lib/tenancy/admin";
import { canManageInvites, canManageMembers, createInvite, resendInvite, revokeInvite, type InviteErrorCode } from "./server";

// Team management server actions (P4.4), shared by /app/settings/team and onboarding step 6.
// Every action needs MFA verified in this session; invites go through the invite functions
// (owners and managers), member changes through the owner-only RLS policies on garage_members.

const TEAM_PATHS = ["/app/settings/team", "/app/onboarding/team"];
const MEMBER_ROLES: GarageRole[] = ["owner", "manager", "technician", "front_desk"];
const uuid = z.string().uuid();

async function teamContext(): Promise<AdminContext | null> {
  const admin = await getAdminContext();
  return admin?.mfaVerified ? admin : null;
}

function refresh() {
  for (const path of TEAM_PATHS) revalidatePath(path);
}

export type InviteFormState = {
  seq: number;
  errors: FieldErrors<InviteField>;
  message?: string;
  /** Shown once after sending: the link to share if the email doesn't arrive. */
  sent?: { email: string; role: InviteRole; link: string; emailed: boolean; resent: boolean };
};

const INVITE_MESSAGES: Record<InviteErrorCode | "mfa", string> = {
  UNAUTHORISED: "Only owners and managers can invite staff.",
  INVITE_ALREADY_MEMBER: "That person is already on your team.",
  INVITE_NOT_FOUND: "That invite has been used or withdrawn.",
  INVALID_INVITE: "Check the email address and role.",
  UNAVAILABLE: "The invite could not be sent. Try again.",
  mfa: "Verify your sign-in with your authenticator app first.",
};

export async function inviteStaffAction(previous: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const seq = previous.seq + 1;
  const parsed = parseInviteForm(formData);
  if (!parsed.ok) return { seq, errors: parsed.errors };
  const admin = await teamContext();
  if (!admin) return { seq, errors: {}, message: INVITE_MESSAGES.mfa };
  if (!canManageInvites(admin.role)) return { seq, errors: {}, message: INVITE_MESSAGES.UNAUTHORISED };
  const result = await createInvite(admin, parsed.value);
  if (!result.ok) {
    return result.code === "INVITE_ALREADY_MEMBER"
      ? { seq, errors: { email: INVITE_MESSAGES.INVITE_ALREADY_MEMBER } }
      : { seq, errors: {}, message: INVITE_MESSAGES[result.code] };
  }
  refresh();
  return { seq, errors: {}, sent: { email: result.email, role: result.role, link: result.link, emailed: result.emailed, resent: result.resent } };
}

export async function resendInviteAction(previous: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const seq = previous.seq + 1;
  const id = uuid.safeParse(formData.get("inviteId"));
  const admin = await teamContext();
  if (!admin) return { seq, errors: {}, message: INVITE_MESSAGES.mfa };
  if (!id.success || !canManageInvites(admin.role)) return { seq, errors: {}, message: INVITE_MESSAGES.UNAUTHORISED };
  const result = await resendInvite(admin, id.data);
  if (!result.ok) return { seq, errors: {}, message: INVITE_MESSAGES[result.code] };
  refresh();
  return { seq, errors: {}, sent: { email: result.email, role: result.role, link: result.link, emailed: result.emailed, resent: true } };
}

/** Plain form actions answer with `?team=` codes on the page they came from (one of TEAM_PATHS). */
function back(formData: FormData, code: string): never {
  const from = String(formData.get("from") ?? "");
  redirect(`${TEAM_PATHS.includes(from) ? from : TEAM_PATHS[0]}?team=${code}`);
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const id = uuid.safeParse(formData.get("inviteId"));
  const admin = await teamContext();
  if (!admin) back(formData, "mfa");
  if (!id.success || !canManageInvites(admin.role)) back(formData, "not_allowed");
  const done = await revokeInvite(admin.client, id.data);
  refresh();
  back(formData, done ? "invite_revoked" : "failed");
}

export async function changeMemberRoleAction(formData: FormData): Promise<void> {
  const userId = uuid.safeParse(formData.get("userId"));
  const role = String(formData.get("role") ?? "") as GarageRole;
  const admin = await teamContext();
  if (!admin) back(formData, "mfa");
  if (!userId.success || !MEMBER_ROLES.includes(role) || !canManageMembers(admin.role)) back(formData, "not_allowed");
  const { data, error } = await admin.client
    .from("garage_members")
    .update({ role })
    .eq("garage_id", admin.garage.id)
    .eq("user_id", userId.data)
    .select("id")
    .maybeSingle();
  if (error?.message?.includes("GARAGE_NEEDS_AN_OWNER")) back(formData, "last_owner");
  if (error || !data) back(formData, "failed");
  await auditSetupChange(admin, "member.role_changed", "garage_member", userId.data, { role });
  refresh();
  back(formData, "role_changed");
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const userId = uuid.safeParse(formData.get("userId"));
  const admin = await teamContext();
  if (!admin) back(formData, "mfa");
  if (!userId.success || !canManageMembers(admin.role)) back(formData, "not_allowed");
  const { data, error } = await admin.client
    .from("garage_members")
    .delete()
    .eq("garage_id", admin.garage.id)
    .eq("user_id", userId.data)
    .select("id")
    .maybeSingle();
  if (error?.message?.includes("GARAGE_NEEDS_AN_OWNER")) back(formData, "last_owner");
  if (error || !data) back(formData, "failed");
  await auditSetupChange(admin, "member.removed", "garage_member", userId.data);
  refresh();
  if (userId.data === admin.user.id) redirect("/app");
  back(formData, "member_removed");
}
