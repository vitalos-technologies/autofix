/**
 * P5.6 Reports and exports (Pro, advanced_reports) at /app/reports, the CSV exports under
 * /api/admin/reports/<kind>, and "Who did the job" on the booking page. Runs under
 * playwright.garage.config.ts (project `p5-reports`) against the production build and local Supabase.
 *
 * Its own garage (paid Pro, defaults from seed_garage_defaults()), an owner and a technician with
 * verified TOTP factors, and bookings written with the service role in this month. At the end the
 * garage moves to Essentials and the page shows the locked state; exports answer 403.
 *
 * Every new screen: axe (all rules) at 390 and 1440, no horizontal page scroll, and a full-page
 * screenshot into docs/autofix/screenshots/phase-5/reports-<screen>-<390|1440>.png.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, localRunId, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const SHOTS = "docs/autofix/screenshots/phase-5";

test.describe.configure({ mode: "serial", timeout: 180_000 });

let garage: LocalTestGarage;
let owner: TotpMember;
let technician: TotpMember;
let ownerContext: BrowserContext;
let page: Page;
let collectedId: string;

function londonToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

/** The first Monday to Friday of this month (open 08:00-17:30 by default), garage-local. */
function firstWeekdayOfMonth() {
  for (let day = 1; day <= 7; day += 1) {
    const key = `${londonToday().slice(0, 8)}${String(day).padStart(2, "0")}`;
    const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) return key;
  }
  throw new Error("No weekday in the first week");
}

/** An hour (UTC) on that day: 08:00 UTC is 08:00 or 09:00 London, inside opening hours either way. */
function firstOfMonthAt(hourUtc: number) {
  return new Date(`${firstWeekdayOfMonth()}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`);
}

async function expectAccessibleAt(target: Page, screen: string) {
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    await expect(target.locator("main")).toHaveCount(1);
    await expect(target.locator("h1:visible")).toHaveCount(1);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px on ${new URL(target.url()).pathname}`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
    await target.screenshot({ path: `${SHOTS}/reports-${screen}-${width}.png`, fullPage: true });
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

async function one<T>(query: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error || data === null || data === undefined) throw new Error(`${what}: ${error?.message ?? "no data"}`);
  return data as NonNullable<T>;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "r");
  await one(service.from("garages").update({ plan: "pro", plan_chosen: "pro", trial_ends_at: null }).eq("id", garage.id).select("id"), "make the garage Pro");
  await one(service.rpc("seed_garage_defaults", { p_garage_id: garage.id }), "seed defaults");
  owner = await createTotpMember(service, garage.id, "owner", "reports-owner");
  technician = await createTotpMember(service, garage.id, "technician", "reports-technician");

  const services = await one(service.from("services").select("id, name, price_pence").eq("garage_id", garage.id), "services");
  const bays = await one(service.from("resources").select("id, name").eq("garage_id", garage.id).eq("kind", "bay").order("sort"), "bays");
  const diagnostics = services.find((row) => row.name === "Diagnostics")!;
  const fullService = services.find((row) => row.name === "Full service")!;
  const customer = await one<{ id: string }>(
    service.from("customers").insert({ garage_id: garage.id, name: "Report Customer", phone: "+447700900561", preferred_contact: "phone" }).select("id").single(),
    "customer",
  );
  const vehicle = await one<{ id: string }>(
    service.from("vehicles").insert({ garage_id: garage.id, customer_id: customer.id, registration: `RP${localRunId.slice(0, 5)}`.toUpperCase() }).select("id").single(),
    "vehicle",
  );
  const at = (hours: number) => firstOfMonthAt(hours);
  const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000).toISOString();
  const rows = [
    { service: diagnostics, bay: bays[0]!, start: at(8), minutes: 60, status: "collected" },
    { service: fullService, bay: bays[1]!, start: at(9), minutes: 120, status: "confirmed" },
  ];
  const inserted = await one(
    service
      .from("bookings")
      .insert(
        rows.map((row) => ({
          garage_id: garage.id,
          customer_id: customer.id,
          vehicle_id: vehicle.id,
          service_id: row.service.id,
          resource_id: row.bay.id,
          starts_at: row.start.toISOString(),
          ends_at: plus(row.start, row.minutes),
          during: `[${row.start.toISOString()},${plus(row.start, row.minutes + 15)})`,
          status: row.status,
          source: "phone",
          price_pence: row.service.price_pence ?? 0,
        })),
      )
      .select("id, status"),
    "bookings",
  );
  collectedId = inserted.find((row) => row.status === "collected")!.id;
  const start = at(8);
  await one(
    service
      .from("booking_events")
      .insert([
        { garage_id: garage.id, booking_id: collectedId, type: "status_changed", actor: "staff", at: plus(start, -5), data: { from: "confirmed", to: "arrived" } },
        { garage_id: garage.id, booking_id: collectedId, type: "status_changed", actor: "staff", at: plus(start, 0), data: { from: "arrived", to: "in_progress" } },
        { garage_id: garage.id, booking_id: collectedId, type: "status_changed", actor: "staff", at: plus(start, 50), data: { from: "in_progress", to: "ready" } },
        { garage_id: garage.id, booking_id: collectedId, type: "status_changed", actor: "staff", at: plus(start, 90), data: { from: "ready", to: "collected" } },
      ])
      .select("id"),
    "events",
  );

  ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await ownerContext.newPage();
  await signInWithTotp(page, adminOrigin, owner);
});

test.afterAll(async () => {
  await ownerContext?.close();
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  for (const member of [owner, technician]) if (member) await service.auth.admin.deleteUser(member.id);
});

test("an owner sees this month's reports from the Grow nav", async () => {
  await page.goto(`${adminOrigin}/app`);
  await page.getByRole("link", { name: "Reports", exact: true }).first().click();
  await page.waitForURL(/\/app\/reports$/);
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute("aria-current", "page");

  const byService = page.getByRole("region", { name: /^Revenue by service,/ });
  await expect(byService.getByRole("row", { name: /Diagnostics/ })).toContainText("£");
  await expect(byService.getByRole("row", { name: /Full service/ })).toContainText("not invoiced yet");
  await expect(page.getByRole("region", { name: /^Revenue by technician,/ }).getByRole("row", { name: /Unassigned/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Hours sold vs worked,/ }).getByRole("row", { name: /Unassigned/ })).toContainText("1 h / 50 min");
  await expect(page.getByRole("region", { name: /^Bay utilisation by bay,/ }).getByRole("row", { name: /Bay 1/ })).toContainText("1 h 15 min of");
  await expectAccessibleAt(page, "page");
});

test("the date picker moves between presets and custom dates", async () => {
  await page.getByRole("link", { name: "Last month" }).click();
  await page.waitForURL(/range=last_month/);
  await expect(page.getByRole("link", { name: "Last month" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: /^Revenue by service,/ }).getByRole("row", { name: /Diagnostics/ })).toHaveCount(0);

  const day = firstWeekdayOfMonth();
  await page.getByLabel("From", { exact: true }).fill(day);
  await page.getByLabel("To", { exact: true }).fill(day);
  await page.getByRole("button", { name: "Show dates" }).click();
  await page.waitForURL(new RegExp(`range=custom&from=${day}&to=${day}$`));
  await expect(page.getByRole("status").filter({ hasText: "(1 day)" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Revenue by service,/ }).getByRole("row", { name: /Diagnostics/ })).toBeVisible();

  await page.goto(`${adminOrigin}/app/reports?range=custom&from=2026-10-10&to=2026-10-01`);
  await expect(page.getByRole("alert").filter({ hasText: "The end date must be on or after the start date." })).toBeVisible();
});

test("each report downloads as a CSV attachment with only dates in its name", async () => {
  await page.goto(`${adminOrigin}/app/reports`);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download revenue by service as CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^autofix-revenue-by-service-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.csv$/);

  for (const kind of ["revenue-by-service", "revenue-by-technician", "bay-utilisation", "hours", "reminder-roi"]) {
    const response = await page.request.get(`${adminOrigin}/api/admin/reports/${kind}?range=this_month`);
    expect(response.status(), kind).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers()["content-disposition"]).toMatch(/^attachment; filename="autofix-/);
    const body = await response.text();
    expect(body.replace(/^﻿/, "").startsWith('"'), kind).toBe(true);
    expect(body).not.toContain(`RP${localRunId.slice(0, 5)}`.toUpperCase());
  }
});

test("owners choose who did the job on the booking page, and revenue follows", async () => {
  await page.goto(`${adminOrigin}/app/bookings/${collectedId}`);
  const panel = page.getByRole("region", { name: "Technician" });
  await panel.getByLabel("Who did the job").selectOption({ label: "Test technician (Technician)" });
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved: Test technician did this job.");
  await expectAccessibleAt(page, "booking-technician");

  await page.goto(`${adminOrigin}/app/reports`);
  await expect(page.getByRole("region", { name: /^Revenue by technician,/ }).getByRole("row", { name: /Test technician/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Hours sold vs worked,/ }).getByRole("row", { name: /Test technician/ })).toContainText("1 h / 50 min");
});

test("technicians are told to ask the owner, and cannot export", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const tech = await context.newPage();
  try {
    await signInWithTotp(tech, adminOrigin, technician);
    await tech.goto(`${adminOrigin}/app/reports`);
    await expect(tech.getByRole("heading", { name: "Reports are for owners and managers" })).toBeVisible();
    await expect(tech.getByRole("region", { name: /^Revenue by service,/ })).toHaveCount(0);
    await expectAccessibleAt(tech, "technician");
    const response = await tech.request.get(`${adminOrigin}/api/admin/reports/hours?range=this_month`);
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: "NOT_ALLOWED" });
    await tech.goto(`${adminOrigin}/app/bookings/${collectedId}`);
    await expect(tech.getByRole("region", { name: "Technician" })).toContainText("Test technician did this job.");
    await expect(tech.getByLabel("Who did the job")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("on Essentials the page is locked, exports are 403 and assignments stay readable", async () => {
  await one(
    service.from("garages").update({ plan: "essentials", plan_chosen: "essentials", trial_ends_at: null }).eq("id", garage.id).select("id"),
    "move to Essentials",
  );
  await page.goto(`${adminOrigin}/app/reports`);
  await expect(page.getByRole("heading", { name: /Reports and exports is on Pro/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "See Pro and upgrade" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Revenue by service,/ })).toHaveCount(0);
  await expectAccessibleAt(page, "locked");

  const response = await page.request.get(`${adminOrigin}/api/admin/reports/revenue-by-service?range=this_month`);
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ code: "PLAN_REQUIRED", feature: "advanced_reports" });

  await page.goto(`${adminOrigin}/app/bookings/${collectedId}`);
  await expect(page.getByRole("region", { name: "Technician" })).toContainText("Test technician did this job.");
  await expect(page.getByLabel("Who did the job")).toHaveCount(0);
});
