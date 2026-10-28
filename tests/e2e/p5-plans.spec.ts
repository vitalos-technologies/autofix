/**
 * P5.2 plans (D17) at /app/settings/plan, under playwright.garage.config.ts (project `p5-plans`) against the
 * production build and local Supabase. Billing runs on the mock provider (BILLING_PROVIDER unset), so
 * "Upgrade" is "Request Pro".
 *
 * The spec makes its own garages (new garages start on the 14-day Pro trial), an owner and a manager with
 * verified TOTP, and removes them afterwards. Checks: the trial and its days left, Request Pro (a plan request
 * for Vitalos), moving to Essentials (confirmation, trial ends, plan label), the manager's read-only view with
 * usage, an expired trial counting as Essentials before the expiry job and the job moving it, axe with no
 * violations at 390 and 1440 with no horizontal scroll, and screenshots for docs/autofix/screenshots/phase-5.
 */
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const PATH = "/app/settings/plan";
const SHOTS = "docs/autofix/screenshots/phase-5";
const service = createLocalClient(getLocalSupabaseConfig().secretKey);

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let expired: LocalTestGarage;
let owner: TotpMember;
let manager: TotpMember;
let expiredOwner: TotpMember;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  garage = await createLocalGarage(service, "pl");
  expired = await createLocalGarage(service, "px");
  owner = await createTotpMember(service, garage.id, "owner", "plan-owner");
  manager = await createTotpMember(service, garage.id, "manager", "plan-manager");
  expiredOwner = await createTotpMember(service, expired.id, "owner", "plan-expired");
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await signInWithTotp(page, adminOrigin, owner);
});

test.afterAll(async () => {
  await context?.close();
  for (const target of [garage, expired]) if (target) await service.from("garages").delete().eq("id", target.id);
  for (const member of [owner, manager, expiredOwner]) if (member) await service.auth.admin.deleteUser(member.id);
});

async function expectAccessibleAt(target: Page, shot: string) {
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
    await target.screenshot({ path: `${SHOTS}/plans-${shot}-${width}.png`, fullPage: true });
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

async function garageRow(id: string) {
  const { data, error } = await service.from("garages").select("plan,plan_chosen,trial_ends_at").eq("id", id).single();
  if (error) throw error;
  return data as { plan: string; plan_chosen: string | null; trial_ends_at: string | null };
}

test("a new garage is on the 14-day Pro trial and the page says so", async () => {
  const row = await garageRow(garage.id);
  expect(row.plan).toBe("pro");
  expect(row.trial_ends_at).not.toBeNull();
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
  await expect(page.getByText("Pro trial", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Pro trial: 14 days left, until/)).toBeVisible();
  await expect(page.getByText(/When the trial ends you move to Essentials unless you choose Pro/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Essentials and Pro" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pro", exact: true })).toBeVisible();
  await expect(page.getByText("Price to be confirmed").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Texts this month" })).toBeVisible();
  await expectAccessibleAt(page, "trial");
});

test("the owner requests Pro and Vitalos gets a plan request", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await page.getByLabel("Anything Vitalos should know? (optional)").fill("Interested in health checks");
  await page.getByRole("button", { name: "Request Pro" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Vitalos has your request for Pro" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${PATH}\\?done=requested$`));
  const { data } = await service.from("plan_requests").select("requested_plan,status,note").eq("garage_id", garage.id);
  expect(data).toEqual([{ requested_plan: "pro", status: "open", note: "Interested in health checks" }]);
  await expect(page.getByText(/You asked Vitalos for Pro on/)).toBeVisible();
});

test("a manager sees the plan and usage but cannot change it", async ({ browser }) => {
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const managerPage = await managerContext.newPage();
  await signInWithTotp(managerPage, adminOrigin, manager);
  await managerPage.goto(`${adminOrigin}${PATH}`);
  await expect(managerPage.getByText("Only the garage owner can change the plan.")).toBeVisible();
  await expect(managerPage.getByRole("button", { name: /Request Pro|Upgrade/ })).toHaveCount(0);
  await expect(managerPage.getByRole("heading", { name: "Texts this month" })).toBeVisible();
  await managerContext.close();
});

test("the owner moves to Essentials after a confirmation; the trial ends and the label changes", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await page.getByRole("button", { name: "Move to Essentials" }).click();
  await expect(page.getByText(/Move to Essentials now\? Your trial ends today/)).toBeVisible();
  await expectAccessibleAt(page, "confirm-essentials");
  await page.getByRole("button", { name: "Yes, move to Essentials" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You're on Essentials" })).toBeVisible();
  expect(await garageRow(garage.id)).toEqual({ plan: "essentials", plan_chosen: "essentials", trial_ends_at: null });
  await expect(page.getByText("Essentials.", { exact: true })).toBeVisible();
  const { data } = await service.from("plan_requests").select("status").eq("garage_id", garage.id);
  expect(data).toEqual([{ status: "withdrawn" }]);
  await expectAccessibleAt(page, "essentials");
});

test("an expired trial is Essentials at once, and the expiry job moves it", async ({ browser }) => {
  await service.from("garages").update({ plan: "pro", plan_chosen: null, trial_ends_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", expired.id);
  const expiredContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const expiredPage = await expiredContext.newPage();
  await signInWithTotp(expiredPage, adminOrigin, expiredOwner);
  await expiredPage.goto(`${adminOrigin}${PATH}`);
  await expect(expiredPage.getByText("Essentials.", { exact: true })).toBeVisible();
  await expect(expiredPage.getByRole("button", { name: "Request Pro" })).toBeVisible();
  const { data, error } = await service.rpc("expire_plan_trials", { p_now: new Date().toISOString() });
  expect(error).toBeNull();
  expect(data).toBeGreaterThanOrEqual(1);
  expect(await garageRow(expired.id)).toEqual({ plan: "essentials", plan_chosen: null, trial_ends_at: null });
  const audit = await service.from("admin_audit_log").select("action").eq("garage_id", expired.id).eq("action", "plan.trial_ended");
  expect(audit.data).toHaveLength(1);
  await expiredContext.close();
});
