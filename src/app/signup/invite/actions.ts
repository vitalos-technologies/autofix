"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { hashInviteToken, INVITE_COOKIE, isInviteToken } from "@/lib/signup/invite-token";
import { PASSWORD_MIN_LENGTH } from "@/lib/signup/schema";
import { requestIp } from "@/lib/signup/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { GARAGE_COOKIE, GARAGE_COOKIE_OPTIONS } from "@/lib/tenancy/admin";
import { previewInvite } from "@/lib/team/server";

// Accepting a staff invite (P4.4). The token comes only from the httpOnly cookie the link set;
// the database checks it, its expiry and that the signed-in account has the invited email.

export type InviteActionState = { seq: number; message?: string; field?: "name" | "password" };

const ACCEPT_MESSAGES = {
  INVITE_NOT_FOUND: "This invite has been used or withdrawn. Ask the garage for a new one.",
  INVITE_EXPIRED: "This invite has expired. Ask the garage to send it again.",
  INVITE_EMAIL_MISMATCH: "You're signed in with a different email address from the one invited.",
  GARAGE_UNAVAILABLE: "This garage isn't taking new staff on Autofix right now.",
} as const;

async function inviteToken() {
  const token = (await cookies()).get(INVITE_COOKIE)?.value;
  return isInviteToken(token) ? token : null;
}

/** Accepts with the signed-in session, selects the garage and opens the admin. */
async function acceptAndEnter(): Promise<string> {
  const token = await inviteToken();
  if (!token) return ACCEPT_MESSAGES.INVITE_NOT_FOUND;
  const client = await createClient();
  if (!client) return "Invites are not available right now.";
  const { data, error } = await client.rpc("accept_garage_invite", { p_token_hash: hashInviteToken(token) });
  if (error || !data) {
    const code = (Object.keys(ACCEPT_MESSAGES) as Array<keyof typeof ACCEPT_MESSAGES>).find((candidate) => error?.message?.startsWith(candidate));
    return code ? ACCEPT_MESSAGES[code] : "The invite could not be accepted. Try again.";
  }
  const store = await cookies();
  store.set(GARAGE_COOKIE, String((data as { garage_id: string }).garage_id), GARAGE_COOKIE_OPTIONS);
  store.delete({ name: INVITE_COOKIE, path: "/signup/invite" });
  redirect("/app");
}

export async function acceptInviteAction(previous: InviteActionState): Promise<InviteActionState> {
  return { seq: previous.seq + 1, message: await acceptAndEnter() };
}

/** Existing account: sign in with the invited email's password, then accept. */
export async function signInAndAcceptAction(previous: InviteActionState, formData: FormData): Promise<InviteActionState> {
  const seq = previous.seq + 1;
  const token = await inviteToken();
  const preview = token ? await previewInvite(token) : null;
  if (!token || !preview || preview.status !== "open") return { seq, message: ACCEPT_MESSAGES.INVITE_NOT_FOUND };
  const password = String(formData.get("password") ?? "").slice(0, 1_024);
  const ip = await requestIp();
  if (!(await consumeRateLimit(`${preview.email}:${ip}`, "admin_login_source", 8, 300)) || !(await consumeRateLimit(preview.email, "admin_login_account", 30, 900))) {
    return { seq, message: "Sign-in failed. Check your password and try again.", field: "password" };
  }
  const client = await createClient();
  if (!client) return { seq, message: "Sign-in is not available right now." };
  const { error } = await client.auth.signInWithPassword({ email: preview.email, password });
  if (error) return { seq, message: "Sign-in failed. Check your password and try again.", field: "password" };
  return { seq, message: await acceptAndEnter() };
}

/**
 * New to Autofix: the invite link proves the address, so the account is created already confirmed
 * (service role), signed in and joined in one go.
 */
export async function createAccountAndAcceptAction(previous: InviteActionState, formData: FormData): Promise<InviteActionState> {
  const seq = previous.seq + 1;
  const token = await inviteToken();
  const preview = token ? await previewInvite(token) : null;
  if (!token || !preview || preview.status !== "open" || preview.accountExists) return { seq, message: ACCEPT_MESSAGES.INVITE_NOT_FOUND };
  const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
  const password = String(formData.get("password") ?? "");
  if (name.length < 2 || name.length > 100) return { seq, message: "Enter your name.", field: "name" };
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
    return { seq, message: `Use a password of at least ${PASSWORD_MIN_LENGTH} characters.`, field: "password" };
  }
  if (!(await consumeRateLimit(await requestIp(), "signup_ip", 5, 3_600))) return { seq, message: "Too many accounts created from here. Wait an hour and try again." };

  const service = createAdminClient();
  const client = await createClient();
  if (!service || !client) return { seq, message: "Accounts can't be created right now." };
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: preview.email,
    password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });
  if (createError || !created.user) {
    return createError?.code === "weak_password"
      ? { seq, message: "Choose a stronger password.", field: "password" }
      : { seq, message: "Your account could not be created. Try again." };
  }
  await service.from("admin_profiles").upsert({ user_id: created.user.id, display_name: name }, { onConflict: "user_id" });
  const { error: signInError } = await client.auth.signInWithPassword({ email: preview.email, password });
  if (signInError) return { seq, message: "Your account was created. Sign in to accept the invite." };
  return { seq, message: await acceptAndEnter() };
}

export async function signOutForInviteAction(): Promise<void> {
  const client = await createClient();
  await client?.auth.signOut();
  redirect("/signup/invite");
}
