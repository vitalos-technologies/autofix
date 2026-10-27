/**
 * Super admin (P4.5) at /admin on the admin host. Runs under playwright.garage.config.ts (project `super-admin`)
 * against the production build and local Supabase.
 *
 * The spec makes its own garage, a garage owner and a Vitalos platform admin (in `platform_admins`, verified
 * TOTP, no garage) with the service role, and a failed job. It checks that /admin is a 404 for everyone but the
 * platform admin, that the admin signs in through /app/login and the /admin/verify TOTP step, finds the garage,
 * changes its status with a reason, views it read-only as support (and ends that), and retries the failed job.
 * Every /admin page has no axe violations at 390 and 1440 wide and no horizontal page scroll.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, createTotpPlatformAdmin, signInAsPlatformAdmin, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, localTestPassword, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let owner: TotpMember;
let platformAdmin: TotpMember;
let jobId: string;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "sa");
  owner = await createTotpMember(service, garage.id, "owner", "super-admin-owner");
  platformAdmin = await createTotpPlatformAdmin(service, "super-admin");
  const job = await service.from("jobs").insert({
    kind: "platform.e2e_probe", garage_id: garage.id, status: "failed", attempts: 5, max_attempts: 5,
    finished_at: new Date().toISOString(), last_error: "SEND_FAILED to +447700900123 for AB12 CDE",
  }).select("id").single();
  if (job.error) throw new Error(`Could not add a failed job: ${job.error.message}`);
  jobId = job.data.id;
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  if (jobId) await service.from("jobs").delete().eq("id", jobId);
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  for (const member of [owner, platformAdmin]) if (member) await service.auth.admin.deleteUser(member.id);
});

async function expectAccessibleAt(target: Page, widths: number[] = [390, 1440]) {
  for (const width of widths) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px on ${new URL(target.url()).pathname}`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

test("/admin is a 404 for signed-out users and garage staff", async ({ browser }) => {
  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  for (const path of ["/admin", "/admin/jobs", `/admin/garages/${garage.id}`, "/admin/verify"]) {
    expect((await anonymousPage.goto(`${adminOrigin}${path}`))?.status(), path).toBe(404);
  }
  expect((await anonymousPage.request.get(`${adminOrigin}/api/platform/garages`)).status()).toBe(404);
  await anonymous.close();

  const staff = await browser.newContext();
  const staffPage = await staff.newPage();
  await signInWithTotp(staffPage, adminOrigin, owner);
  expect((await staffPage.goto(`${adminOrigin}/admin`))?.status()).toBe(404);
  expect((await staffPage.request.get(`${adminOrigin}/api/platform/health`)).status()).toBe(404);
  await staff.close();
});

test("the MFA step for platform admins is accessible", async ({ browser }) => {
  const pending = await browser.newContext();
  const pendingPage = await pending.newPage();
  await pendingPage.goto(`${adminOrigin}/app/login`);
  await pendingPage.getByLabel("Email").fill(platformAdmin.email);
  await pendingPage.getByLabel("Password").fill(localTestPassword);
  await pendingPage.getByRole("button", { name: "Sign in" }).click();
  await expect(pendingPage).toHaveURL(/\/admin\/verify$/);
  await expect(pendingPage.getByRole("heading", { level: 1, name: "Two-factor authentication", exact: true })).toBeVisible();
  // Until the code is entered, the rest of /admin stays closed.
  expect((await pendingPage.request.get(`${adminOrigin}/api/platform/garages`)).status()).toBe(404);
  await expectAccessibleAt(pendingPage);
  await pending.close();
});

test("a platform admin signs in with TOTP and finds the garage", async () => {
  await signInAsPlatformAdmin(page, adminOrigin, platformAdmin);
  await expect(page.getByRole("heading", { level: 1, name: "Garages", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Platform" }).getByRole("link", { name: "Garages" })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Name or slug").fill(garage.slug);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`q=${garage.slug}`));
  await expect(page.getByRole("link", { name: garage.name })).toBeVisible();
  await expectAccessibleAt(page);
  expect((await page.request.get(`${adminOrigin}/api/platform/garages?q=${garage.slug}`)).status()).toBe(200);
});

test("the admin suspends the garage with a reason, and the garage's log has it", async () => {
  await page.getByRole("link", { name: garage.name }).click();
  await expect(page.getByRole("heading", { level: 1, name: garage.name, exact: true })).toBeVisible();
  await expectAccessibleAt(page);
  await page.getByLabel("Status", { exact: true }).selectOption("suspended");
  await page.getByRole("region", { name: "Plan and status" }).getByLabel("Reason").fill("E2E: unpaid invoice");
  await page.getByRole("button", { name: "Save plan and status" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const { data } = await service.from("admin_audit_log").select("action,detail").eq("garage_id", garage.id).eq("action", "platform.garage_status_changed");
  expect(data?.[0]?.detail).toMatchObject({ from: "active", to: "suspended", reason: "E2E: unpaid invoice" });
  await page.getByLabel("Status", { exact: true }).selectOption("active");
  await page.getByRole("region", { name: "Plan and status" }).getByLabel("Reason").fill("E2E: paid, reopening");
  await page.getByRole("button", { name: "Save plan and status" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test("the admin views the garage read-only as support, then ends it", async () => {
  await page.getByRole("region", { name: "View as support" }).getByLabel("Reason").fill("E2E support ticket");
  await page.getByRole("button", { name: "Start read-only session" }).click();
  await expect(page).toHaveURL(/\/app\/?$/);
  await expect(page.getByText(garage.name).first()).toBeVisible();

  const { data: views } = await service.from("admin_audit_log").select("action,detail").eq("garage_id", garage.id).like("action", "platform.impersonation_%");
  expect(views?.map((row) => row.action)).toEqual(expect.arrayContaining(["platform.impersonation_started", "platform.impersonation_page_view"]));

  await page.goto(`${adminOrigin}/admin`);
  const banner = page.getByRole("region", { name: "Support session" });
  await expect(banner).toContainText(`You are viewing ${garage.name} as Vitalos support`);
  await expectAccessibleAt(page);
  await banner.getByRole("button", { name: "End impersonation" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("region", { name: "Support session" })).toHaveCount(0);
  const { data: sessions } = await service.from("platform_impersonations").select("end_reason").eq("garage_id", garage.id);
  expect(sessions).toEqual([{ end_reason: "ended" }]);
});

test("job health shows the failure redacted and retries it", async () => {
  await page.getByRole("navigation", { name: "Platform" }).getByRole("link", { name: "Job health" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Job health", exact: true })).toBeVisible();
  const failure = page.getByRole("listitem").filter({ hasText: "platform.e2e_probe" });
  await expect(failure).toContainText("SEND_FAILED to [phone] for [reg]");
  await expect(page.getByText("AB12 CDE")).toHaveCount(0);
  await expectAccessibleAt(page);
  await failure.getByLabel("Reason to retry").fill("E2E provider fixed");
  await failure.getByRole("button", { name: "Retry platform.e2e_probe job" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Queued again" })).toBeVisible();
  const { data } = await service.from("jobs").select("status").eq("id", jobId).single();
  expect(data?.status).toBe("queued");
});
