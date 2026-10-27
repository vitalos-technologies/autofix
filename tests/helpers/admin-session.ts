import { createHmac, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient, getLocalSupabaseConfig, localTestPassword } from "./local-supabase";

// Garage staff for browser tests: a confirmed Auth user with a verified TOTP
// factor (mandatory MFA stays on, as shipped), a garage membership and a
// profile. The spec signs in through the real password + MFA screens with
// `signInWithTotp`, using a TOTP window that has not been used yet.

const TOTP_STEP_MS = 30_000;

export type TotpMember = {
  id: string;
  email: string;
  secret: string;
  /** TOTP window of the last code used, so no code is replayed. */
  lastWindow: number;
};

export async function createTotpMember(
  service: SupabaseClient,
  garageId: string,
  role: "owner" | "manager" | "technician",
  label: string,
): Promise<TotpMember> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data: created, error: createError } = await service.auth.admin.createUser({ email, password: localTestPassword, email_confirm: true });
  if (createError || !created.user) throw new Error(`Could not create local ${role}: ${createError?.message}`);
  const { error: membershipError } = await service.from("garage_members").insert({ garage_id: garageId, user_id: created.user.id, role });
  if (membershipError) throw new Error(`Could not add local ${role}: ${membershipError.message}`);
  await service.from("admin_profiles").upsert({ user_id: created.user.id, display_name: `Test ${role}` });

  const auth = createLocalClient(getLocalSupabaseConfig().publishableKey);
  const { error: signInError } = await auth.auth.signInWithPassword({ email, password: localTestPassword });
  if (signInError) throw new Error(`Could not sign in local ${role}: ${signInError.message}`);
  const { data: enrollment, error: enrollmentError } = await auth.auth.mfa.enroll({ factorType: "totp", friendlyName: `${label} e2e` });
  if (enrollmentError || !enrollment || enrollment.type !== "totp") throw new Error(`Could not enrol TOTP for ${role}: ${enrollmentError?.message}`);
  const window = currentWindow();
  const { error: verifyError } = await auth.auth.mfa.challengeAndVerify({ factorId: enrollment.id, code: totp(enrollment.totp.secret, window) });
  if (verifyError) throw new Error(`Could not verify TOTP for ${role}: ${verifyError.message}`);
  return { id: created.user.id, email, secret: enrollment.totp.secret, lastWindow: window };
}

/**
 * A Vitalos platform admin (P4.5): a confirmed Auth user in `platform_admins` with a verified TOTP factor and
 * no garage. They sign in at /app/login and verify at /admin/verify (`signInAsPlatformAdmin`).
 */
export async function createTotpPlatformAdmin(service: SupabaseClient, label: string): Promise<TotpMember> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data: created, error: createError } = await service.auth.admin.createUser({ email, password: localTestPassword, email_confirm: true });
  if (createError || !created.user) throw new Error(`Could not create local platform admin: ${createError?.message}`);
  const { error: adminError } = await service.from("platform_admins").insert({ user_id: created.user.id });
  if (adminError) throw new Error(`Could not add local platform admin: ${adminError.message}`);
  await service.from("admin_profiles").upsert({ user_id: created.user.id, display_name: "Vitalos support" });

  const auth = createLocalClient(getLocalSupabaseConfig().publishableKey);
  const { error: signInError } = await auth.auth.signInWithPassword({ email, password: localTestPassword });
  if (signInError) throw new Error(`Could not sign in local platform admin: ${signInError.message}`);
  const { data: enrollment, error: enrollmentError } = await auth.auth.mfa.enroll({ factorType: "totp", friendlyName: `${label} e2e` });
  if (enrollmentError || !enrollment || enrollment.type !== "totp") throw new Error(`Could not enrol TOTP: ${enrollmentError?.message}`);
  const window = currentWindow();
  const { error: verifyError } = await auth.auth.mfa.challengeAndVerify({ factorId: enrollment.id, code: totp(enrollment.totp.secret, window) });
  if (verifyError) throw new Error(`Could not verify TOTP: ${verifyError.message}`);
  return { id: created.user.id, email, secret: enrollment.totp.secret, lastWindow: window };
}

/** Signs a platform admin in at /app/login, then verifies the TOTP code at /admin/verify, and waits for /admin. */
export async function signInAsPlatformAdmin(page: Page, adminOrigin: string, member: TotpMember) {
  await page.goto(`${adminOrigin}/app/login`);
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(localTestPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/verify$/);
  const window = await nextUnusedWindow(member);
  await page.getByLabel("Verification code").fill(totp(member.secret, window));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** Signs in at `<adminOrigin>/app/login` with the password, then the TOTP code, and waits for the admin home. */
export async function signInWithTotp(page: Page, adminOrigin: string, member: TotpMember) {
  await page.goto(`${adminOrigin}/app/login`);
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(localTestPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/mfa(?:\?.*)?$/);
  const window = await nextUnusedWindow(member);
  await page.getByLabel("Verification code").fill(totp(member.secret, window));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/app(?:\/)?(?:\?.*)?$/);
}

function currentWindow() {
  return Math.floor(Date.now() / TOTP_STEP_MS);
}

/** Waits (at most one step) for a TOTP window that has not been used, with time left for the round trip. */
async function nextUnusedWindow(member: TotpMember) {
  while (currentWindow() <= member.lastWindow) {
    await new Promise((resolve) => setTimeout(resolve, (member.lastWindow + 1) * TOTP_STEP_MS - Date.now() + 250));
  }
  if (TOTP_STEP_MS - (Date.now() % TOTP_STEP_MS) < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, TOTP_STEP_MS - (Date.now() % TOTP_STEP_MS) + 250));
  }
  member.lastWindow = currentWindow();
  return member.lastWindow;
}

export function totp(secret: string, window: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(window));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function base32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/g, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("TOTP secret is not base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}
