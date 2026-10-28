/**
 * P5.9 multi-site (Pro `multi_site`) at /app/group, under playwright.garage.config.ts (project `p5-multi-site`)
 * against the production build and local Supabase. Billing runs on the mock provider (record only).
 *
 * The spec makes its own garages (a paid-Pro home garage with an owner and a manager, and an Essentials garage
 * with its owner), all with verified TOTP, and removes them afterwards. Checks: the group of one, adding a site
 * (new garage on the group's plan, the owner its owner, extra sites recorded), the overview with both sites and
 * the switcher's "Group overview" link, the report CSV, a manager seeing only the site they manage, taking a
 * site out of the group (count goes down), the locked page for Essentials; axe with no violations at 390 and
 * 1440 with no horizontal scroll, and screenshots for docs/autofix/screenshots/phase-5.
 */
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const PATH = "/app/group";
const SHOTS = "docs/autofix/screenshots/phase-5";
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const siteSlug = `p59-north-${randomUUID().slice(0, 6)}`;
const siteName = "Multi-site North Garage";

test.describe.configure({ mode: "serial" });

let home: LocalTestGarage;
let essentials: LocalTestGarage;
let owner: TotpMember;
let manager: TotpMember;
let essentialsOwner: TotpMember;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  home = await createLocalGarage(service, "ms");
  essentials = await createLocalGarage(service, "me");
  await service.from("garages").update({ plan: "pro", plan_chosen: "pro", trial_ends_at: null }).eq("id", home.id);
  await service.from("garages").update({ plan: "essentials", plan_chosen: "essentials", trial_ends_at: null }).eq("id", essentials.id);
  owner = await createTotpMember(service, home.id, "owner", "group-owner");
  manager = await createTotpMember(service, home.id, "manager", "group-manager");
  essentialsOwner = await createTotpMember(service, essentials.id, "owner", "group-essentials");
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await signInWithTotp(page, adminOrigin, owner);
});

test.afterAll(async () => {
  await context?.close();
  const { data: site } = await service.from("garages").select("id").eq("slug", siteSlug).maybeSingle();
  if (site) await service.from("garages").delete().eq("id", site.id);
  for (const target of [home, essentials]) if (target) await service.from("garages").delete().eq("id", target.id);
  for (const member of [owner, manager, essentialsOwner]) if (member) await service.auth.admin.deleteUser(member.id);
});

async function expectAccessibleAt(target: Page, shot: string) {
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
    await target.screenshot({ path: `${SHOTS}/multi-site-${shot}-${width}.png`, fullPage: true });
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

async function extraSitesRecorded() {
  const { data } = await service.from("garage_subscriptions").select("extra_sites").eq("garage_id", home.id).maybeSingle();
  return (data as { extra_sites: number } | null)?.extra_sites ?? null;
}

test("a Pro owner with one garage sees a group of one and the add-a-site form", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.getByRole("heading", { level: 1, name: "Group overview" })).toBeVisible();
  await expect(page.getByText("Run several sites under one login. Add your next site below.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add a site" })).toBeVisible();
  await expect(page.getByText(/Each extra site: Price to be confirmed/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Group overview" }).first()).toBeVisible();
  await expectAccessibleAt(page, "single");
});

test("the owner adds a site: it joins the group on the group's plan and the extra site is recorded", async () => {
  await page.goto(`${adminOrigin}${PATH}#add-site`);
  const form = page.getByRole("form", { name: "Add a site" });
  await form.getByLabel("Garage name").fill(siteName);
  await form.getByLabel("Phone customers call").fill("01302 123456");
  await form.getByLabel("Address line 1").fill("12 North Street");
  await form.getByLabel("Town or city").fill("Doncaster");
  await form.getByLabel("Postcode").fill("DN1 1AA");
  await form.getByLabel("Free booking link").fill(siteSlug);
  await form.getByRole("button", { name: "Add site" }).click();
  await expect(page.getByRole("status").filter({ hasText: `${siteName} is added to your group (1 extra site)` })).toBeVisible();

  const { data: site } = await service.from("garages").select("id,plan,plan_chosen,trial_ends_at").eq("slug", siteSlug).single();
  expect(site).toMatchObject({ plan: "pro", plan_chosen: "pro", trial_ends_at: null });
  const { data: membership } = await service.from("garage_members").select("role").eq("garage_id", site!.id).eq("user_id", owner.id).single();
  expect(membership?.role).toBe("owner");
  const { count } = await service.from("garage_group_sites").select("garage_id", { count: "exact", head: true }).eq("home_garage_id", home.id);
  expect(count).toBe(2);
  expect(await extraSitesRecorded()).toBe(1);
});

test("the overview lists both sites with totals, and the switcher links to it", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.getByText("2 sites under one login.", { exact: false })).toBeVisible();
  const sites = page.getByRole("list", { name: "Sites in your group" });
  await expect(sites.getByRole("listitem")).toHaveCount(2);
  await expect(sites.getByText(siteName)).toBeVisible();
  await expect(page.getByRole("group", { name: "All sites" })).toBeVisible();
  await page.getByText("Switch garage. Current:").click();
  await expect(page.getByRole("link", { name: "Group overview" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expectAccessibleAt(page, "overview");
});

test("the report exports bookings and revenue by site as CSV", async () => {
  const response = await page.request.get(`${adminOrigin}/api/admin/group/report?from=2026-10-01&to=2026-10-28`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.text();
  expect(body).toContain('"Site","From","To","Bookings","Revenue GBP"');
  expect(body).toContain(`"${siteName}","2026-10-01","2026-10-28","0","0.00"`);
  expect(body).toContain('"All sites"');
});

test("a manager of the home garage only sees that site", async ({ browser }) => {
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const managerPage = await managerContext.newPage();
  await signInWithTotp(managerPage, adminOrigin, manager);
  await managerPage.goto(`${adminOrigin}${PATH}`);
  await expect(managerPage.getByRole("list", { name: "Sites in your group" }).getByRole("listitem")).toHaveCount(1);
  await expect(managerPage.getByText(/1 more site is in your group but not shown/)).toBeVisible();
  await expect(managerPage.getByRole("heading", { name: "Add a site" })).toHaveCount(0);
  await managerContext.close();
});

test("the owner takes the site out of the group after a confirmation; the count goes down", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await page.getByRole("link", { name: `Remove ${siteName} from the group` }).click();
  await expect(page.getByRole("heading", { name: `Take ${siteName} out of the group?` })).toBeVisible();
  await expectAccessibleAt(page, "remove-confirm");
  await page.getByRole("button", { name: "Take it out of the group" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The site is out of the group." })).toBeVisible();
  expect(await extraSitesRecorded()).toBe(0);
  const { data: site } = await service.from("garages").select("plan,plan_chosen").eq("slug", siteSlug).single();
  expect(site).toEqual({ plan: "essentials", plan_chosen: "essentials" });
});

test("an Essentials owner sees the locked Pro page and the report API refuses", async ({ browser }) => {
  const lockedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const lockedPage = await lockedContext.newPage();
  await signInWithTotp(lockedPage, adminOrigin, essentialsOwner);
  await lockedPage.goto(`${adminOrigin}${PATH}`);
  await expect(lockedPage.getByRole("heading", { level: 1, name: "Group overview" })).toBeVisible();
  await expect(lockedPage.getByRole("heading", { name: /Several sites, one login is on Pro/ })).toBeVisible();
  await expect(lockedPage.getByRole("link", { name: "See Pro and upgrade" })).toBeVisible();
  const response = await lockedPage.request.get(`${adminOrigin}/api/admin/group/report`);
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ code: "PLAN_REQUIRED", feature: "multi_site" });
  await expectAccessibleAt(lockedPage, "locked");
  await lockedContext.close();
});
