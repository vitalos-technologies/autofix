/**
 * Legal pages on a garage host (P4.9): the privacy notice and the unsubscribe page, at 390px.
 * Runs under playwright.garage.config.ts (project legal-mobile) against `pnpm build && pnpm start`
 * with the demo seed. Each run adds one fictional customer to hartley-road and removes it (and its
 * audit rows) afterwards; the seeded customers are never touched.
 */
import { createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { getLocalSupabaseConfig } from "../helpers/local-supabase";

const port = Number(process.env.PLAYWRIGHT_PORT || "3430");
const DEMO_B_ORIGIN = `http://demo-b.localhost:${port}`;
// The same local-only key playwright.garage.config.ts gives the server.
const SIGNING_KEY = process.env.BOOKING_MANAGEMENT_SECRET || "playwright-local-booking-management-key-not-a-secret";
const PHONE = "+447700900977";
const PHONE_TYPED = "07700 900977";
const UNKNOWN_PHONE_TYPED = "07700 900976";
const GENERIC_ANSWER =
  "If that number is on our list, you won't get any more reminders from Hartley Road Motors. You'll still get messages about bookings you make. You can also reply STOP to any reminder text.";

/** src/lib/consent/unsubscribe-token.ts, re-implemented so the test checks the format independently. */
function unsubscribeToken(garageId: string, customerId: string) {
  const tag = createHmac("sha256", SIGNING_KEY).update(`customer-unsubscribe:v1:${garageId}:${customerId}`).digest().subarray(0, 16);
  return `${Buffer.from(customerId.replace(/-/g, ""), "hex").toString("base64url")}.${tag.toString("base64url")}`;
}

async function expectAccessible(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function noHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

let service: SupabaseClient;
let garageId: string;
let customerId: string;

async function customerRow() {
  const { data, error } = await service.from("customers").select("opted_out_at,reminder_consent,consent_source,consent_text").eq("id", customerId).single();
  if (error) throw new Error(error.message);
  return data;
}

async function auditActions() {
  const { data, error } = await service.from("admin_audit_log").select("action,detail").eq("garage_id", garageId).eq("entity_id", customerId).order("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => `${row.action}:${(row.detail as { source?: string }).source}`);
}

async function resetOptOut() {
  const { error } = await service.from("customers").update({ opted_out_at: null }).eq("id", customerId);
  if (error) throw new Error(error.message);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const config = getLocalSupabaseConfig();
  service = createClient(config.url, config.secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const garage = await service.from("garages").select("id").eq("slug", "hartley-road").single();
  if (garage.error) throw new Error(`seeded garage missing (run pnpm db:seed): ${garage.error.message}`);
  garageId = garage.data.id;
  await service.from("customers").delete().eq("garage_id", garageId).eq("phone", PHONE);
  const inserted = await service
    .from("customers")
    .insert({ garage_id: garageId, name: "Legal Spec Customer", phone: PHONE, preferred_contact: "phone", channel: "sms" })
    .select("id")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  customerId = inserted.data.id;
});

test.afterAll(async () => {
  if (!customerId) return;
  await service.from("admin_audit_log").delete().eq("garage_id", garageId).eq("entity_id", customerId);
  await service.from("customers").delete().eq("id", customerId);
});

test.describe("privacy notice", () => {
  test("is filled in for the garage, flagged as a draft, and accessible", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Privacy notice" }).click();
    await page.waitForURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1, name: "Privacy notice for customers of Hartley Road Motors" })).toBeVisible();
    await expect(page.getByText(/^Draft v0\.1, pending solicitor review\./)).toBeVisible();
    const article = page.locator("article");
    await expect(article).toContainText("Vitalos Technologies Ltd, which handles your data for us under a contract");
    await expect(article).toContainText("Information Commissioner's Office");
    await expect(article).not.toContainText(/\[(Garage|address|email|phone|date)/);
    await noHorizontalOverflow(page);
    await expectAccessible(page);
  });
});

test.describe("unsubscribe", () => {
  test("the form gives the same answer for any number and opts out a customer of this garage", async ({ page }) => {
    await page.goto("/unsubscribe");
    await expect(page.getByRole("heading", { level: 1, name: "Stop reminders" })).toBeVisible();
    await expect(page.getByText("Enter the mobile number we text you on and we'll stop reminders from Hartley Road Motors.")).toBeVisible();
    await noHorizontalOverflow(page);
    await expectAccessible(page);

    await page.getByLabel("Mobile number").fill("12");
    await page.getByRole("button", { name: "Stop reminders" }).click();
    await expect(page.getByText("Enter a UK mobile number, for example 07700 900123.")).toBeVisible();

    await page.getByLabel("Mobile number").fill(UNKNOWN_PHONE_TYPED);
    await page.getByRole("button", { name: "Stop reminders" }).click();
    await expect(page.getByRole("status")).toHaveText(GENERIC_ANSWER);
    await expectAccessible(page);

    await page.goto("/unsubscribe");
    await page.getByLabel("Mobile number").fill(PHONE_TYPED);
    await page.getByRole("button", { name: "Stop reminders" }).click();
    await expect(page.getByRole("status")).toHaveText(GENERIC_ANSWER);
    expect((await customerRow()).opted_out_at).not.toBeNull();
    expect(await auditActions()).toEqual(["customer.opted_out:unsubscribe_form"]);
    await resetOptOut();
  });

  test("a signed link opts out straight away and can turn reminders back on", async ({ page }) => {
    const token = unsubscribeToken(garageId, customerId);
    await page.goto(`/unsubscribe/${token}`);
    await expect(page.getByRole("heading", { level: 1, name: "Reminders stopped" })).toBeVisible();
    await expect(page.getByText("You won't get any more reminders from Hartley Road Motors. You'll still get messages about bookings you make.")).toBeVisible();
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    expect((await customerRow()).opted_out_at).not.toBeNull();
    await noHorizontalOverflow(page);
    await expectAccessible(page);

    // Opening the link again changes nothing more.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Reminders stopped" })).toBeVisible();

    await page.getByRole("button", { name: "Turn reminders back on" }).click();
    await page.waitForURL(new RegExp(`/unsubscribe/${token.replace(".", "\\.")}/resumed$`));
    await expect(page.getByRole("heading", { level: 1, name: "Reminders are back on" })).toBeVisible();
    await expectAccessible(page);
    expect(await customerRow()).toMatchObject({
      opted_out_at: null,
      reminder_consent: true,
      consent_source: "unsubscribe_page",
      consent_text: "Reminders are back on. Hartley Road Motors will send you reminders again. You can stop them any time.",
    });
    expect(await auditActions()).toEqual([
      "customer.opted_out:unsubscribe_form",
      "customer.opted_out:unsubscribe_link",
      "customer.opted_in:unsubscribe_page",
    ]);
  });

  test("a tampered link, or one for another garage, does nothing", async ({ page }) => {
    const token = unsubscribeToken(garageId, customerId);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await page.goto(`/unsubscribe/${tampered}`);
    await expect(page.getByRole("heading", { level: 1, name: "This link doesn't work" })).toBeVisible();
    await expectAccessible(page);

    await page.goto(`${DEMO_B_ORIGIN}/unsubscribe/${token}`);
    await expect(page.getByRole("heading", { level: 1, name: "This link doesn't work" })).toBeVisible();
    expect((await customerRow()).opted_out_at).toBeNull();
  });
});
