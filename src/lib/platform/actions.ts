"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isSixDigitMfaCode } from "@/lib/auth/mfa";
import { getAllowedPlatformAdmin, getPlatformAdmin } from "@/lib/platform/access";
import {
  cleanReason,
  IMPERSONATION_COOKIE,
  IMPERSONATION_COOKIE_OPTIONS,
  IMPERSONATION_MAX_MINUTES,
  IMPERSONATION_MIN_MINUTES,
  IMPERSONATION_MINUTES,
  isGaragePlan,
  isGarageStatus,
} from "@/lib/platform/policy";
import { endImpersonation, PlatformError, retryJob, startImpersonation, updateGarage } from "@/lib/platform/store";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export type PlatformFormState = { status: "idle" | "saved" | "error"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_HELP = "Give a reason of 5 to 500 characters. It is logged and shown to the garage's owners.";

function uuidField(formData: FormData, name: string) {
  const value = String(formData.get(name) ?? "").trim();
  return UUID.test(value) ? value.toLowerCase() : null;
}

/** Platform actions answer like the pages: no admin, no area (404). */
async function allowedAdmin() {
  const admin = await getAllowedPlatformAdmin();
  if (!admin) notFound();
  return admin;
}

export async function updateGarageAction(_: PlatformFormState, formData: FormData): Promise<PlatformFormState> {
  const admin = await allowedAdmin();
  const garageId = uuidField(formData, "garageId");
  const plan = formData.get("plan");
  const status = formData.get("status");
  const reason = cleanReason(formData.get("reason"));
  if (!garageId) return { status: "error", message: "That garage could not be found." };
  if (!isGaragePlan(plan) || !isGarageStatus(status)) return { status: "error", message: "Choose a plan and a status." };
  if (!reason) return { status: "error", message: REASON_HELP };
  try {
    await updateGarage(admin.client, garageId, { plan, status, reason });
  } catch (error) {
    return { status: "error", message: error instanceof PlatformError && error.code === "GARAGE_NOT_FOUND" ? "That garage could not be found." : "The change could not be saved. Try again." };
  }
  revalidatePath(`/admin/garages/${garageId}`);
  revalidatePath("/admin");
  return { status: "saved", message: "Saved. The change is in the garage's audit log." };
}

export async function startImpersonationAction(_: PlatformFormState, formData: FormData): Promise<PlatformFormState> {
  const admin = await allowedAdmin();
  const garageId = uuidField(formData, "garageId");
  const reason = cleanReason(formData.get("reason"));
  const minutes = Number(formData.get("minutes") ?? IMPERSONATION_MINUTES);
  if (!garageId) return { status: "error", message: "That garage could not be found." };
  if (!reason) return { status: "error", message: REASON_HELP };
  if (!Number.isInteger(minutes) || minutes < IMPERSONATION_MIN_MINUTES || minutes > IMPERSONATION_MAX_MINUTES) {
    return { status: "error", message: `Choose ${IMPERSONATION_MIN_MINUTES} to ${IMPERSONATION_MAX_MINUTES} minutes.` };
  }
  try {
    await startImpersonation(admin.client, garageId, reason, minutes);
  } catch {
    return { status: "error", message: "Impersonation could not start. Try again." };
  }
  (await cookies()).set(IMPERSONATION_COOKIE, "1", IMPERSONATION_COOKIE_OPTIONS);
  redirect("/app");
}

/** Ends the caller's impersonation (the banner's button). Any platform admin, MFA or not: ending is always safe. */
export async function endImpersonationAction() {
  const admin = await getPlatformAdmin();
  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATION_COOKIE, "", { ...IMPERSONATION_COOKIE_OPTIONS, maxAge: 0 });
  if (admin) {
    try {
      await endImpersonation(admin.client);
    } catch {
      // The cookie is gone and the session expires on its own; nothing else to undo.
    }
  }
  if (!admin) redirect("/app");
  revalidatePath("/app", "layout");
  redirect("/admin");
}

export async function retryJobAction(_: PlatformFormState, formData: FormData): Promise<PlatformFormState> {
  const admin = await allowedAdmin();
  const jobId = uuidField(formData, "jobId");
  const reason = cleanReason(formData.get("reason"));
  if (!jobId) return { status: "error", message: "That job could not be found." };
  if (!reason) return { status: "error", message: REASON_HELP };
  let retried = false;
  try {
    retried = await retryJob(admin.client, jobId, reason);
  } catch {
    return { status: "error", message: "The job could not be retried. Try again." };
  }
  // No revalidate: the row keeps its confirmation until the next visit, when the job has left the failures.
  return retried
    ? { status: "saved", message: "Queued again with fresh attempts. Reload to refresh the list." }
    : { status: "error", message: "Only failed jobs can be retried. It may have been retried already." };
}

// ---------------------------------------------------------------------------
// MFA for platform admins (they may belong to no garage, so /app/mfa is not theirs)
// ---------------------------------------------------------------------------

export type PlatformMfaState = { message: string };
export type PlatformEnrolment = { factorId: string; qrCode: string; secret: string } | { error: string };

async function pendingAdmin() {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();
  return admin;
}

export async function verifyPlatformMfaAction(_: PlatformMfaState, formData: FormData): Promise<PlatformMfaState> {
  const admin = await pendingAdmin();
  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  const factorId = String(formData.get("factorId") ?? "");
  if (!isSixDigitMfaCode(code)) return { message: "Enter the 6-digit code from your authenticator app." };
  if (!(await consumeRateLimit(admin.user.id, "platform_mfa_challenge", 6, 300))) {
    return { message: "Too many verification attempts. Please wait before trying again." };
  }
  const { data: factors, error: factorsError } = await admin.client.auth.mfa.listFactors();
  // Enrolment verifies an unverified factor; the challenge a verified one.
  const factor = factors?.all.find((item) => item.id === factorId && item.factor_type === "totp");
  if (factorsError || !factor) return { message: "The authenticator could not be verified. Sign in again and retry." };
  const { error } = await admin.client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) return { message: "That verification code is incorrect or has expired." };
  redirect("/admin");
}

/** Starts TOTP enrolment for a platform admin with no verified factor. Stale unverified factors are removed first. */
export async function startPlatformEnrolmentAction(): Promise<PlatformEnrolment> {
  const admin = await pendingAdmin();
  if (admin.access !== "enroll") return { error: "Your account already has an authenticator." };
  const { data: factors } = await admin.client.auth.mfa.listFactors();
  for (const stale of factors?.all.filter((item) => item.factor_type === "totp" && item.status === "unverified") ?? []) {
    await admin.client.auth.mfa.unenroll({ factorId: stale.id });
  }
  const { data, error } = await admin.client.auth.mfa.enroll({ factorType: "totp", friendlyName: `Pitline platform ${crypto.randomUUID().slice(0, 8)}` });
  if (error || !data || data.type !== "totp") return { error: "The authenticator could not be set up. Try again." };
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

export async function signOutPlatformAction() {
  const client = await createClient();
  await client?.auth.signOut();
  (await cookies()).set(IMPERSONATION_COOKIE, "", { ...IMPERSONATION_COOKIE_OPTIONS, maxAge: 0 });
  redirect("/app/login");
}
