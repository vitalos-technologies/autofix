/**
 * P5.12 AI front desk on Pro at /app/settings/ai-front-desk, under playwright.garage.config.ts (project
 * `p5-ai-front-desk`) against the production build and local Supabase.
 *
 * The spec makes its own garage (new garages start on the Pro trial) and an owner with verified TOTP,
 * and removes them afterwards. Checks: the Setup nav link, the owner's switch (on, then off), creating a
 * Workforce token (shown once, then listed, then revoked), AI minutes recorded through record_usage()
 * shown here and on Settings, Plan with the same figure, the locked page for an Essentials garage with the
 * missed-call text-back line, and axe with no violations at 390 and 1440 with no horizontal scroll.
 * D22: switching the desk on queues the garage's own AI desk number at once; on the mock Twilio account (a
 * trial, like the real one today) "Your AI desk number" says it waits for the upgrade and nothing is bought.
 * Screenshots go to docs/autofix/screenshots/phase-5/ai-front-desk-*.png.
 */
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const PATH = "/app/settings/ai-front-desk";
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const SHOTS = path.join(process.cwd(), "docs/autofix/screenshots/phase-5");

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let owner: TotpMember;
let admin: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  garage = await createLocalGarage(service, "fd");
  owner = await createTotpMember(service, garage.id, "owner", "afd-owner");
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await admin.newPage();
  await signInWithTotp(page, adminOrigin, owner);
});

test.afterAll(async () => {
  await admin?.close();
  if (garage) {
    await service.from("jobs").delete().eq("garage_id", garage.id);
    await service.from("garages").delete().eq("id", garage.id);
  }
  if (owner) await service.auth.admin.deleteUser(owner.id);
});

async function expectAccessibleAt(target: Page, screen: string) {
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    // As in settings.spec.ts: only while SOB's shell nests a <main> are its three landmark rules left out.
    const nestedMain = await target.evaluate(() => document.querySelectorAll("main main").length > 0);
    const axe = new AxeBuilder({ page: target });
    if (nestedMain) axe.disableRules(["landmark-main-is-top-level", "landmark-no-duplicate-main", "landmark-unique"]);
    const results = await axe.analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
    await target.screenshot({ path: path.join(SHOTS, `ai-front-desk-${screen}-${width}.png`), fullPage: true });
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

test("Pro: the switch, a Workforce token shown once then revoked, and this month's minutes", async () => {
  test.setTimeout(120_000);
  await page.goto(`${adminOrigin}/app`);
  await page.getByRole("link", { name: "AI front desk" }).first().click();
  await page.waitForURL(`**${PATH}`);
  await expect(page.getByRole("heading", { level: 1, name: "AI front desk" })).toBeVisible();

  const toggle = page.getByRole("switch", { name: "AI front desk" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await page.waitForURL(/done=enabled/);
  await expect(page.getByRole("switch", { name: "AI front desk" })).toHaveAttribute("aria-checked", "true");
  const { data: settings } = await service.from("ai_front_desk_settings").select("enabled").eq("garage_id", garage.id).single();
  expect(settings?.enabled).toBe(true);

  // D22: the number check ran straight after the switch (numbers.provision for this garage, drained by after()).
  const deskNumber = page.locator("#number");
  await expect(deskNumber.getByRole("heading", { level: 2, name: "Your AI desk number" })).toBeVisible();
  await expect.poll(async () => {
    await page.reload();
    return (await deskNumber.textContent()) ?? "";
  }, { timeout: 30_000, message: "the number state after switching on" }).toContain("Waiting for upgrade");
  await expect(deskNumber.getByRole("status")).toContainText("Vitalos is upgrading the account with our phone provider (Twilio).");
  const { data: numberState } = await service.from("ai_front_desk_numbers").select("status,number,provider_sid").eq("garage_id", garage.id).single();
  expect(numberState).toEqual({ status: "waiting_upgrade", number: null, provider_sid: null });
  const { count: routed } = await service.from("garage_phone_numbers").select("id", { count: "exact", head: true }).eq("garage_id", garage.id);
  expect(routed).toBe(0);

  // Once the account is upgraded the job attaches the bought number exactly like this (service role); the page
  // then shows it with the divert codes. A number from Ofcom's 01632 960xxx drama range, unique to this garage.
  const suffix = (parseInt(garage.id.replaceAll("-", "").slice(0, 8), 16) % 1000).toString().padStart(3, "0");
  const desk = `+441632960${suffix}`;
  const attached = await service.rpc("attach_ai_front_desk_number", {
    p_garage_id: garage.id,
    p_number: desk,
    p_provider_sid: `PN${createHash("sha256").update(garage.id).digest("hex").slice(0, 32)}`,
    p_ring_garage_first: false,
  });
  expect(attached.error).toBeNull();
  await page.reload();
  await expect(deskNumber.getByText("Ready")).toBeVisible();
  await expect(deskNumber.getByRole("link", { name: `01632 960${suffix}` })).toHaveAttribute("href", `tel:${desk}`);
  await expect(deskNumber.getByRole("list", { name: "Divert codes" }).getByRole("listitem")).toHaveCount(3);
  await expect(deskNumber).toContainText(`**61*01632960${suffix}#`);
  await expectAccessibleAt(page, "number-ready");

  const tokens = page.locator("#tokens");
  await tokens.getByLabel("Token name").fill("Workforce pilot");
  await tokens.getByRole("button", { name: "Create token" }).click();
  const shown = tokens.locator("#new-token");
  await expect(shown).toHaveText(/^afat_[A-Za-z0-9_-]{43}$/);
  await expect(tokens.getByRole("button", { name: /Copy token/ })).toBeVisible();
  const { data: stored } = await service.from("agent_tokens").select("token_hash,audience,scopes").eq("garage_id", garage.id).single();
  expect(stored?.audience).toBe("workforce");
  expect(stored?.scopes).toContain("report_usage");
  expect(stored?.token_hash).not.toContain((await shown.textContent())!.slice(5, 15));

  // Minutes reported by Workforce land in the meter here and on the Plan page.
  const conversation = `CA${randomUUID().replaceAll("-", "")}`;
  const recorded = await service.rpc("record_usage", { p_garage_id: garage.id, p_metric: "ai_minutes", p_quantity: 3.5, p_source_key: `ai:${conversation}`, p_at: new Date().toISOString() });
  expect(recorded.error).toBeNull();
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(tokens.locator("#new-token")).toHaveCount(0);
  await expect(tokens.getByRole("listitem").filter({ hasText: "Workforce pilot" })).toContainText("Live");
  const minutes = page.locator("#minutes");
  await expect(minutes).toContainText("AI front desk minutes this month");
  await expect(minutes).toContainText("3.5");
  await expectAccessibleAt(page, "settings");

  await page.goto(`${adminOrigin}/app/settings/plan`);
  await expect(page.locator("#usage")).toContainText("AI front desk minutes this month");
  await expect(page.locator("#usage")).toContainText("3.5");

  await page.goto(`${adminOrigin}${PATH}`);
  await tokens.getByRole("button", { name: "Revoke token Workforce pilot" }).click();
  await page.waitForURL(/done=revoked/);
  await expect(tokens.getByRole("listitem").filter({ hasText: "Workforce pilot" })).toContainText("Revoked");

  await page.getByRole("switch", { name: "AI front desk" }).click();
  await page.waitForURL(/done=disabled/);
  await expect(page.getByRole("switch", { name: "AI front desk" })).toHaveAttribute("aria-checked", "false");
  const { count } = await service.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("garage_id", garage.id).in("action", ["ai_front_desk.enabled", "ai_front_desk.disabled"]);
  expect(count).toBe(2);
  const { count: ready } = await service.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("garage_id", garage.id).eq("action", "ai_front_desk.number_ready");
  expect(ready).toBe(1);
  // Switching the desk off keeps the number (nothing is released, A436).
  await expect(deskNumber.getByText("Kept")).toBeVisible();
  await expect(deskNumber.getByRole("link", { name: `01632 960${suffix}` })).toBeVisible();
});

test("Essentials: the locked page, and missed calls still get a text back", async () => {
  test.setTimeout(60_000);
  const { error } = await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  expect(error).toBeNull();
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.getByRole("heading", { level: 1, name: "AI front desk" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /AI front desk is on Pro/ })).toBeVisible();
  await expect(page.getByText("Missed calls still get a text back and can leave a voicemail on Essentials.")).toBeVisible();
  await expect(page.getByRole("link", { name: "See Pro and upgrade" })).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expectAccessibleAt(page, "locked");
});
