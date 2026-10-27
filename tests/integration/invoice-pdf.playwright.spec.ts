import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import {
  getLocalSupabaseConfig,
  invoiceDraftPayload,
  localTestPassword,
  provisionLocalTestUsers,
  type LocalTestUsers,
} from "../helpers/local-supabase";

// Staff access is membership of a garage (no email allowlist), and owners use
// TOTP. Each run provisions its own garages A and B plus an owner for each
// whose TOTP secret the spec knows, so the browser can sign in through the
// real password + MFA screens.

const appOrigin = "http://127.0.0.1:3100";
const totpStepMs = 30_000;

type MfaOwner = {
  email: string;
  secret: string;
  /** TOTP window of the last code used, so no code is replayed. */
  lastWindow: number;
  /** AAL2 SSR session cookies from enrollment. */
  cookies: Array<{ name: string; value: string; url: string }>;
};

let users: LocalTestUsers;
let invoiceId: string;
let ownerA: MfaOwner;
let ownerB: MfaOwner;

test.beforeAll(async () => {
  users = await provisionLocalTestUsers();
  const draft = await users.admin.rpc("save_invoice_draft", {
    p_invoice_id: null,
    p_payload: invoiceDraftPayload("2087-08-11", "pdf-access"),
    p_confirm_duplicate_source: false,
  });
  if (draft.error || !draft.data) throw new Error(`Could not create PDF fixture: ${draft.error?.message}`);
  invoiceId = String(draft.data);

  const issued = await users.admin.rpc("issue_invoice", { p_invoice_id: invoiceId });
  if (issued.error) throw new Error(`Could not issue PDF fixture: ${issued.error.message}`);

  ownerA = await createMfaOwner(users.garageA.id, "a");
  ownerB = await createMfaOwner(users.garageB.id, "b");
});

test("a garage owner signs in with password and TOTP and downloads the garage's PDF", async ({ context, page }) => {
  test.setTimeout(90_000);
  await page.goto("/app/login");
  await page.getByLabel("Email").fill(ownerA.email);
  await page.getByLabel("Password").fill(localTestPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/mfa(?:\?.*)?$/);

  const window = await nextUnusedWindow(ownerA);
  await page.getByLabel("Verification code").fill(totp(ownerA.secret, window));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/app(?:\/)?$/);
  await expect(page.getByText(users.garageA.name).first()).toBeVisible();
  await expect(page.getByText(users.garageB.name)).toHaveCount(0);

  const response = await context.request.get(`${appOrigin}/api/admin/invoices/${invoiceId}/pdf`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect(response.headers()["content-disposition"]).toMatch(new RegExp(`filename="Invoice-${users.garageA.bookingPrefix}-2087-\\d{6}\\.pdf"`));
  expect(response.headers()["cache-control"]).toContain("private");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
});

test("another garage's owner gets not found for the invoice", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.addCookies(ownerB.cookies);
    const response = await context.request.get(`${appOrigin}/api/admin/invoices/${invoiceId}/pdf`);
    expect(response.status()).toBe(404);
    expect(response.headers()["cache-control"]).toContain("no-store");

    // A forged af_garage cookie for garage A changes nothing.
    await context.addCookies([{ name: "af_garage", value: users.garageA.id, url: appOrigin }]);
    const forged = await context.request.get(`${appOrigin}/api/admin/invoices/${invoiceId}/pdf`);
    expect(forged.status()).toBe(404);
  } finally {
    await context.close();
  }
});

test("a signed-in user with no garage membership is denied the PDF", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.addCookies((await sessionClient(users.nonAdminIdentity.email)).cookies());
    const response = await context.request.get(`${appOrigin}/api/admin/invoices/${invoiceId}/pdf`);
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  } finally {
    await context.close();
  }
});

test("an anonymous caller is denied the PDF", async ({ request }) => {
  const response = await request.get(`${appOrigin}/api/admin/invoices/${invoiceId}/pdf`);
  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toContain("no-store");
});

async function createMfaOwner(garageId: string, label: string): Promise<MfaOwner> {
  const email = `invoice-pdf-owner-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data: created, error: createError } = await users.service.auth.admin.createUser({ email, password: localTestPassword, email_confirm: true });
  if (createError || !created.user) throw new Error(`Could not create local owner ${label}: ${createError?.message}`);
  const { error: membershipError } = await users.service.from("garage_members").insert({ garage_id: garageId, user_id: created.user.id, role: "owner" });
  if (membershipError) throw new Error(`Could not add local owner ${label}: ${membershipError.message}`);

  const session = await sessionClient(email);
  const { data: enrollment, error: enrollmentError } = await session.client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Invoice PDF e2e" });
  if (enrollmentError || !enrollment || enrollment.type !== "totp") throw new Error(`Could not enroll local owner ${label}: ${enrollmentError?.message}`);
  const window = currentWindow();
  const { error: verifyError } = await session.client.auth.mfa.challengeAndVerify({ factorId: enrollment.id, code: totp(enrollment.totp.secret, window) });
  if (verifyError) throw new Error(`Could not verify local owner ${label}: ${verifyError.message}`);
  return { email, secret: enrollment.totp.secret, lastWindow: window, cookies: session.cookies() };
}

/** Password sign-in through the SSR client, keeping its cookies for the browser. */
async function sessionClient(email: string) {
  const { url, publishableKey } = getLocalSupabaseConfig();
  const jar = new Map<string, string>();
  const client = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.options.maxAge === 0) jar.delete(cookie.name);
          else jar.set(cookie.name, cookie.value);
        }
      },
    },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: localTestPassword });
  if (error || !data.session || data.user.email !== email) throw new Error(`Could not create a local browser session: ${error?.message ?? "invalid session"}`);
  if (jar.size === 0) throw new Error("Local sign-in did not persist an SSR session cookie.");
  return { client, cookies: () => Array.from(jar, ([name, value]) => ({ name, value, url: appOrigin })) };
}

function currentWindow() {
  return Math.floor(Date.now() / totpStepMs);
}

/** Waits (at most one step) until a TOTP window that has not been used yet. */
async function nextUnusedWindow(owner: MfaOwner) {
  while (currentWindow() <= owner.lastWindow) {
    await new Promise((resolve) => setTimeout(resolve, (owner.lastWindow + 1) * totpStepMs - Date.now() + 250));
  }
  // Leave a little time in the window for the form round trip.
  if (totpStepMs - (Date.now() % totpStepMs) < 3_000) await new Promise((resolve) => setTimeout(resolve, totpStepMs - (Date.now() % totpStepMs) + 250));
  owner.lastWindow = currentWindow();
  return owner.lastWindow;
}

function totp(secret: string, window: number) {
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
