"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { recordUserSecurityEvent } from "@/lib/admin/audit";
import { canChangeAdminPassword, requiresMfaChallenge } from "@/lib/auth/mfa";
import { isMandatoryAdminMfaEnabled } from "@/lib/auth/mfa-policy";
import { getRecoveryErrorMessage } from "@/lib/auth/recovery-errors";
import { getCurrentTrustedDevice, revokeAllTrustedDevices } from "@/lib/auth/trusted-device-server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { GARAGE_COOKIE, GARAGE_COOKIE_OPTIONS, getAdminContext, loadMemberships } from "@/lib/tenancy/admin";
import { adminUrl } from "@/lib/tenancy/urls";

export type LoginState = { message: string };

async function requestSource() {
  const requestHeaders = await headers();
  return (requestHeaders.get("x-forwarded-for")?.split(",")[0] || requestHeaders.get("x-real-ip") || "unknown").trim().slice(0, 64);
}

/**
 * Staff sign-in. Access is membership of at least one garage
 * (`garage_members`); there is no email allowlist.
 */
export async function loginWithPassword(_: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = z.object({
    email: z.email(),
    password: z.string().min(1).max(1_024),
  }).safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { message: "Enter your email address and password." };
  const source = await requestSource();
  const email = parsed.data.email.trim().toLowerCase();
  if (!(await consumeRateLimit(`${email}:${source}`, "admin_login_source", 8, 300))
    || !(await consumeRateLimit(email, "admin_login_account", 30, 900))) {
    return { message: "Sign-in failed. Check your details and try again." };
  }
  const client = await createClient();
  if (!client) return { message: "Supabase authentication is not configured." };

  const { data: auth, error } = await client.auth.signInWithPassword({
    email,
    password: parsed.data.password,
  });
  if (error || !auth.user) return { message: "Sign-in failed. Check your password and try again." };

  const memberships = await loadMemberships(client, auth.user.id);
  if (!memberships.length) {
    await client.auth.signOut();
    return { message: "This account is not linked to a garage. Ask the garage owner to invite you." };
  }

  const { data: assurance, error: assuranceError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError || !assurance) {
    await client.auth.signOut();
    return { message: "We couldn't verify the account security status. Please try again." };
  }
  const trustedDevice = requiresMfaChallenge(assurance) ? await getCurrentTrustedDevice(auth.user.id) : null;
  if (assurance.currentLevel === "aal1" && assurance.nextLevel === "aal1" && await isMandatoryAdminMfaEnabled(createAdminClient())) {
    redirect("/app/mfa/enroll");
  }
  redirect(requiresMfaChallenge(assurance) && !trustedDevice ? "/app/mfa" : "/app");
}

export async function requestPasswordReset(_: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = z.object({ email: z.email() }).safeParse({ email: formData.get("email") });
  const genericMessage = "If that address belongs to an Autofix account, a password reset link has been sent.";
  if (!parsed.success) return { message: genericMessage };
  const email = parsed.data.email.trim().toLowerCase();
  const source = await requestSource();
  if (!(await consumeRateLimit(`${email}:${source}`, "admin_password_reset_source", 3, 900))
    || !(await consumeRateLimit(email, "admin_password_reset_account", 5, 3_600))) {
    return { message: genericMessage };
  }

  const client = await createClient();
  if (!client) return { message: "Password recovery is not configured." };
  const redirectTo = adminUrl("/auth/confirm?next=/app/reset-password");
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  return { message: error ? getRecoveryErrorMessage(error) : genericMessage };
}

export async function resetAdminPassword(_: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = z.object({
    password: z.string().min(12, "Use at least 12 characters.").max(1_024),
    confirmPassword: z.string().max(1_024),
  }).refine((value) => value.password === value.confirmPassword, { message: "The passwords do not match.", path: ["confirmPassword"] }).safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { message: parsed.error.issues[0]?.message || "Check the new password and try again." };

  const admin = await getAdminContext({ requireMfa: false });
  if (!admin || !canChangeAdminPassword(admin.assurance)) {
    return { message: "This reset link is invalid or has expired. Request a new link." };
  }

  if (!(await revokeAllTrustedDevices(admin.user.id, "mfa_trusted_devices_revoked_password_change"))) {
    return { message: "The password could not be updated securely. Request a new reset link and try again." };
  }
  const { error } = await admin.client.auth.updateUser({ password: parsed.data.password });
  if (error) return { message: "The password could not be updated. Request a new reset link and try again." };
  await recordUserSecurityEvent(admin.user.id, "password_changed");
  await recordUserSecurityEvent(admin.user.id, "global_sign_out", { reason: "password_changed" });
  await admin.client.auth.signOut({ scope: "global" });
  redirect("/app/login?reset=success");
}

export async function signOut() {
  const client = await createClient();
  await client?.auth.signOut();
  (await cookies()).set(GARAGE_COOKIE, "", { ...GARAGE_COOKIE_OPTIONS, maxAge: 0 });
  redirect("/app/login");
}
