import { createHmac, randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

// Customers & cars (P3.11): a garage manager with TOTP (AAL2 session cookies,
// as in tests/integration/invoice-pdf.playwright.spec.ts) imports a CSV,
// confirms the consent declaration, finds a customer by registration (the
// search is a POST; the URL never carries it) and opts them out.
// Needs local Supabase (INTEGRATION_SUPABASE_* or the app's Supabase env);
// skipped otherwise.

const password = "Local-only-9f2e7c4a!";
const totpStepMs = 30_000;

function localSupabase() {
  const url = process.env.INTEGRATION_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const publishableKey = process.env.INTEGRATION_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
  const secretKey = process.env.INTEGRATION_SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET_KEY || "";
  if (!url || !publishableKey || !secretKey) return null;
  const parsed = new URL(url);
  // Local stacks only.
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.protocol !== "http:") return null;
  return { url: parsed.origin, publishableKey, secretKey };
}

const supabase = localSupabase();

// Drama-range numbers; row 4 has a landline and is skipped.
const CSV = [
  "Customer Name,Mobile,Email,Reg No,Consent",
  "Priya Patel,07700 900701,priya@example.test,PL12 AYW,yes",
  "Tom Baker,7700900702,,TB65 KER,no",
  "Office Phone,01302 123456,,,yes",
  "Jo Lane,+44 7700 900703,,,yes",
].join("\n");

test.describe.configure({ mode: "serial" });

test("a manager imports customers, finds one by registration and opts them out", async ({ browser, baseURL }) => {
  test.skip(!supabase || !baseURL, "Local Supabase is not configured");
  test.setTimeout(120_000);
  const appOrigin = baseURL!;
  const { createClient } = await import("@supabase/supabase-js");
  const service = createClient(supabase!.url, supabase!.secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const run = randomUUID().slice(0, 8);
  const { data: garage, error: garageError } = await service
    .from("garages")
    .insert({ slug: `e2e-import-${run}`, name: `Import E2E Garage ${run}`, booking_prefix: "IMP", status: "active", mot_enabled: true })
    .select("id,name")
    .single();
  if (garageError || !garage) throw new Error(`Could not create a garage: ${garageError?.message}`);
  const manager = await createMfaMember(service, garage.id, appOrigin, `import-e2e-${run}@example.test`);

  const context = await browser.newContext();
  try {
    await context.addCookies([...manager.cookies, { name: "af_garage", value: garage.id, url: appOrigin }]);
    const page = await context.newPage();

    await page.goto("/app/customers/import");
    await expect(page.getByRole("heading", { name: "Import customers", level: 1 })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: "old-system.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });

    await expect(page.getByRole("heading", { name: "2. Check what we found" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Problems by row" })).toContainText("Not a UK mobile number");
    const importButton = page.getByRole("button", { name: "Import 3 rows" });
    await importButton.click();
    await expect(page.getByText("Tick the declaration to confirm you hold these customers")).toBeVisible();

    await page.getByLabel(`I confirm these customers gave their details to ${garage.name}`).check();
    await importButton.click();
    await expect(page.getByRole("heading", { name: "Import finished" })).toBeVisible();
    await expect(page.getByText(/3 rows imported in/)).toBeVisible();

    await page.getByRole("link", { name: "View customers" }).click();
    await expect(page).toHaveURL(/\/app\/customers$/);
    await expect(page.getByRole("link", { name: "Priya Patel" }).first()).toBeVisible();

    await page.getByLabel("Search customers").fill("tb65 ker");
    // On phones the page header also has a "Search" toggle for the form; press the form's submit button.
    await page.getByRole("button", { name: "Search" }).and(page.locator("[type=submit]")).click();
    await expect(page.getByRole("link", { name: "Tom Baker" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Priya Patel" })).toHaveCount(0);
    expect(page.url()).not.toMatch(/tb65|TB65/i);

    await page.getByLabel("Search customers").fill("Priya");
    // On phones the page header also has a "Search" toggle for the form; press the form's submit button.
    await page.getByRole("button", { name: "Search" }).and(page.locator("[type=submit]")).click();
    await page.getByRole("link", { name: "Priya Patel" }).first().click();
    await expect(page.getByRole("heading", { name: "Priya Patel", level: 1 })).toBeVisible();
    await expect(page.getByText("Reminders on").first()).toBeVisible();
    await expect(page.getByText(`I confirm these customers gave their details to ${garage.name}`)).toBeVisible();

    await page.getByRole("button", { name: "Opt out of reminders" }).click();
    await expect(page.getByText("Opted out", { exact: true }).first()).toBeVisible();
    const { data: stored } = await service.from("customers").select("opted_out_at,reminder_consent").eq("garage_id", garage.id).eq("phone", "+447700900701").single();
    expect(stored?.opted_out_at).toBeTruthy();
  } finally {
    await context.close();
  }
});

async function createMfaMember(service: SupabaseClient, garageId: string, appOrigin: string, email: string) {
  const { data: created, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !created.user) throw new Error(`Could not create a manager: ${error?.message}`);
  const membership = await service.from("garage_members").insert({ garage_id: garageId, user_id: created.user.id, role: "manager" });
  if (membership.error) throw new Error(`Could not add the manager: ${membership.error.message}`);

  const jar = new Map<string, string>();
  const client = createServerClient(supabase!.url, supabase!.publishableKey, {
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
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`Could not sign in: ${signIn.error.message}`);
  const { data: enrollment, error: enrollError } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Customers e2e" });
  if (enrollError || !enrollment || enrollment.type !== "totp") throw new Error(`Could not enrol TOTP: ${enrollError?.message}`);
  const verify = await client.auth.mfa.challengeAndVerify({ factorId: enrollment.id, code: totp(enrollment.totp.secret, Math.floor(Date.now() / totpStepMs)) });
  if (verify.error) throw new Error(`Could not verify TOTP: ${verify.error.message}`);
  return { cookies: Array.from(jar, ([name, value]) => ({ name, value, url: appOrigin })) };
}

function totp(secret: string, window: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/=+$/g, "").toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) key.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(window));
  const digest = createHmac("sha1", Buffer.from(key)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
