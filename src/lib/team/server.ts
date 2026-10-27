import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getChannel } from "@/lib/messaging/channel";
import { generateInviteToken, hashInviteToken, inviteUrl } from "@/lib/signup/invite-token";
import { ROLE_LABELS, type InviteInput, type InviteRole } from "@/lib/signup/schema";
import { createAdminClient } from "@/lib/supabase/server";
import type { AdminContext, GarageRole } from "@/lib/tenancy/admin";
import { adminBaseUrl } from "@/lib/tenancy/urls";

// Team and invites (P4.4). Members come from `list_garage_team()`; invites are written only by the
// invite functions (`create_garage_invite`, `resend_garage_invite`, `revoke_garage_invite`) through
// the member's RLS client, so the garage is always the selected one. The raw token exists only in
// this process: it is hashed for the database, put in the email and shown once to the sender.

export type TeamMember = { userId: string; email: string | null; displayName: string; role: GarageRole; joinedAt: string; isSelf: boolean };
export type PendingInvite = { id: string; email: string; role: InviteRole; expiresAt: string; lastSentAt: string; sentCount: number; expired: boolean };

export function canManageInvites(role: GarageRole | null | undefined) {
  return role === "owner" || role === "manager";
}

export function canManageMembers(role: GarageRole | null | undefined) {
  return role === "owner";
}

export async function listTeam(client: SupabaseClient): Promise<TeamMember[]> {
  const { data, error } = await client.rpc("list_garage_team");
  if (error) throw new Error(`team load failed: ${error.code ?? "unknown"}`);
  return ((data ?? []) as Array<{ user_id: string; email: string | null; display_name: string; role: GarageRole; joined_at: string; is_self: boolean }>).map((row) => ({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    joinedAt: row.joined_at,
    isSelf: row.is_self,
  }));
}

/** Open invites of the selected garage (`list_garage_invites()`, owners and managers; others get none). */
export async function listPendingInvites(client: SupabaseClient, now = Date.now()): Promise<PendingInvite[]> {
  const { data, error } = await client.rpc("list_garage_invites");
  if (error) throw new Error(`invites load failed: ${error.code ?? "unknown"}`);
  return ((data ?? []) as Array<{ id: string; email: string; role: InviteRole; expires_at: string; last_sent_at: string; sent_count: number }>).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    lastSentAt: row.last_sent_at,
    sentCount: row.sent_count,
    expired: Date.parse(row.expires_at) <= now,
  }));
}

export type InviteErrorCode = "UNAUTHORISED" | "INVITE_ALREADY_MEMBER" | "INVITE_NOT_FOUND" | "INVALID_INVITE" | "UNAVAILABLE";
export type InviteResult = { ok: true; id: string; email: string; role: InviteRole; link: string; emailed: boolean; resent: boolean } | { ok: false; code: InviteErrorCode };

export function inviteError(error: { code?: string | null; message?: string | null } | null | undefined): InviteErrorCode {
  if (error?.code === "42501") return "UNAUTHORISED";
  const message = error?.message ?? "";
  for (const code of ["INVITE_ALREADY_MEMBER", "INVITE_NOT_FOUND", "INVALID_INVITE"] as const) if (message.startsWith(code)) return code;
  return "UNAVAILABLE";
}

/** The invite email: plain text and a small HTML version, no tracking. */
export function composeInviteEmail(input: { garageName: string; inviterName: string; role: InviteRole; link: string }) {
  const role = ROLE_LABELS[input.role].toLowerCase();
  const subject = `Join ${input.garageName} on Autofix`;
  const text = [
    `${input.inviterName} has invited you to join ${input.garageName} on Autofix as ${role === "front desk" ? "front desk" : `a ${role}`}.`,
    "",
    "Accept the invite and set up your account:",
    input.link,
    "",
    "The link works for 7 days. If you weren't expecting this, you can ignore this email.",
  ].join("\n");
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<p>${escape(input.inviterName)} has invited you to join <strong>${escape(input.garageName)}</strong> on Autofix.</p>`
    + `<p><a href="${escape(input.link)}">Accept the invite</a></p><p>The link works for 7 days. If you weren't expecting this, you can ignore this email.</p>`;
  return { subject, text, html };
}

async function deliver(admin: Pick<AdminContext, "garage" | "profile">, email: string, role: InviteRole, link: string, inviteId: string, sequence: number) {
  const message = composeInviteEmail({ garageName: admin.garage.name, inviterName: admin.profile.display_name, role, link });
  try {
    const result = await getChannel("email").send({
      garageId: admin.garage.id,
      to: email,
      subject: message.subject,
      body: message.text,
      html: message.html,
      idempotencyKey: `garage_invite:${inviteId}:${sequence}`,
    });
    return result.ok;
  } catch {
    return false;
  }
}

export async function createInvite(admin: Pick<AdminContext, "client" | "garage" | "profile">, input: InviteInput): Promise<InviteResult> {
  const token = generateInviteToken();
  const { data, error } = await admin.client.rpc("create_garage_invite", { p_email: input.email, p_role: input.role, p_token_hash: hashInviteToken(token) });
  if (error || !data) return { ok: false, code: inviteError(error) };
  const row = data as { id: string; email: string; role: InviteRole; resent: boolean };
  const link = inviteUrl(token, adminBaseUrl());
  const emailed = await deliver(admin, row.email, row.role, link, row.id, Date.now());
  return { ok: true, id: row.id, email: row.email, role: row.role, link, emailed, resent: row.resent };
}

export async function resendInvite(admin: Pick<AdminContext, "client" | "garage" | "profile">, inviteId: string): Promise<InviteResult> {
  const token = generateInviteToken();
  const { data, error } = await admin.client.rpc("resend_garage_invite", { p_invite_id: inviteId, p_token_hash: hashInviteToken(token) });
  if (error || !data) return { ok: false, code: inviteError(error) };
  const row = data as { id: string; email: string; role: InviteRole };
  const link = inviteUrl(token, adminBaseUrl());
  const emailed = await deliver(admin, row.email, row.role, link, row.id, Date.now());
  return { ok: true, id: row.id, email: row.email, role: row.role, link, emailed, resent: true };
}

export async function revokeInvite(client: SupabaseClient, inviteId: string): Promise<boolean> {
  const { data, error } = await client.rpc("revoke_garage_invite", { p_invite_id: inviteId });
  return !error && data === true;
}

export type InvitePreview = {
  status: "open" | "expired" | "used";
  email: string;
  role: InviteRole;
  garageName: string;
  /** Whether an account already exists for the invited email. */
  accountExists: boolean;
};

/** What the accept page shows for a token: looked up by its hash with the service role. */
export async function previewInvite(token: string, service: SupabaseClient | null = createAdminClient()): Promise<InvitePreview | null> {
  if (!service) return null;
  const { data, error } = await service
    .from("garage_invites")
    .select("email,role,expires_at,accepted_at,revoked_at,garage:garages!inner(name,status)")
    .eq("token_hash", hashInviteToken(token))
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as { email: string; role: InviteRole; expires_at: string; accepted_at: string | null; revoked_at: string | null; garage: { name: string; status: string } | Array<{ name: string; status: string }> };
  const garage = Array.isArray(row.garage) ? row.garage[0] : row.garage;
  if (!garage || !["onboarding", "active"].includes(garage.status) || row.revoked_at) return null;
  const { data: exists } = await service.rpc("auth_email_exists", { p_email: row.email });
  return {
    status: row.accepted_at ? "used" : Date.parse(row.expires_at) <= Date.now() ? "expired" : "open",
    email: row.email,
    role: row.role,
    garageName: garage.name,
    accountExists: exists === true,
  };
}
