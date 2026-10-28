/**
 * P5.8 courtesy cars and collection/delivery (Pro, `courtesy_cars`), end to end on the production build and local
 * Supabase (project `p5-courtesy-cars` in playwright.garage.config.ts; `pnpm test:e2e:p5-courtesy-cars`).
 *
 * Its own garage (Pro trial, mobile area DN4, seed_garage_defaults(): Bays 1-3 and a Mobile van) and an owner with a
 * verified TOTP factor. The owner adds two cars and switches "Collection and delivery" on for Interim service; a
 * customer on a 390px phone books Interim service asking for a courtesy car and collection; the owner reserves the
 * car from the booking, sees the Diary badge, checks it out and in. Then the garage moves to Essentials: the page is
 * the locked Pro card and the booking site offers no extras. axe (all rules) at 390 and 1440 on every new screen, no
 * horizontal scroll, screenshots into docs/autofix/screenshots/phase-5/courtesy-cars-<screen>-<390|1440>.png.
 */
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect as baseExpect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, nextCode, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, localTestPassword, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const TIME_ZONE = "Europe/London";
const SHOTS = "docs/autofix/screenshots/phase-5";
// Server actions redirect and re-render; give them time on a busy shared machine.
const expect = baseExpect.configure({ timeout: 20_000 });

test.describe.configure({ mode: "serial", timeout: 120_000 });

let garage: LocalTestGarage;
let owner: TotpMember;
let admin: BrowserContext;
let page: Page;
let siteOrigin: string;
let clientNumber = 0;
let bookingId = "";
let serviceId = "";
const day = openWeekdayAhead();

test.beforeAll(async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  garage = await createLocalGarage(service, "cc");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const { error: updateError } = await service.from("garages").update({ mot_enabled: false, service_area: ["DN4"], mobile_travel_min: 30 }).eq("id", garage.id);
  if (updateError) throw new Error(`Could not set up the garage: ${updateError.message}`);
  const { error: seedError } = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (seedError) throw new Error(`Could not seed garage defaults: ${seedError.message}`);
  const { data: interim } = await service.from("services").select("id").eq("garage_id", garage.id).eq("name", "Interim service").single();
  serviceId = String(interim!.id);
  owner = await createTotpMember(service, garage.id, "owner", "courtesy-owner");
});

test.afterAll(async () => {
  await admin?.close();
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  if (owner) await service.auth.admin.deleteUser(owner.id);
});

async function signedIn(browser: Browser) {
  if (page) return page;
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await admin.newPage();
  // As signInWithTotp (tests/helpers/admin-session.ts), with more time for the redirects on a busy shared machine.
  await page.goto(`${adminOrigin}/app/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(localTestPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/mfa(?:\?.*)?$/, { timeout: 30_000 });
  await page.getByLabel("Verification code").fill(await nextCode(owner));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/app(?:\/)?(?:\?.*)?$/, { timeout: 30_000 });
  return page;
}

/** Each customer context gets its own documentation-range address: the booking pages rate-limit per IP. */
async function newCustomer(browser: Browser) {
  clientNumber += 1;
  return browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${150 + clientNumber}` } });
}

/** A weekday (Mon to Fri) two to twelve days ahead in the garage's time zone. */
function openWeekdayAhead() {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "short" });
  for (let days = 2; days <= 12; days += 1) {
    const instant = new Date(Date.now() + days * 86_400_000);
    if (!["Sat", "Sun"].includes(weekday.format(instant))) return format.format(instant);
  }
  throw new Error("No weekday ahead");
}

function mondayOf(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return new Date(date.getTime() - (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Waits for a courtesy action's redirect (its flash key in the address) on a busy machine. */
async function flashed(target: Page, key: string, kind: "done" | "error" = "done") {
  const name = kind === "done" ? "courtesy" : "courtesyError";
  await target.waitForURL((url) => url.searchParams.get(name) === key, { timeout: 60_000 });
}

async function settle(target: Page) {
  await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
}

/** axe (every rule) and no horizontal scroll at 390 and 1440; optionally a full-page screenshot at each width. */
async function checkScreen(target: Page, shot?: string, widths: number[] = [390, 1440]) {
  const original = target.viewportSize();
  for (const width of widths) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await settle(target);
    await expect(target.locator("main")).toHaveCount(1);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px on ${new URL(target.url()).pathname}`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
    if (shot) await target.screenshot({ path: `${SHOTS}/courtesy-cars-${shot}-${width}.png`, fullPage: true });
  }
  if (original) await target.setViewportSize(original);
}

/** Vehicle → service → time on the garage's booking site, ending on the details step. */
async function toDetails(booking: Page) {
  await booking.goto(`${siteOrigin}/`);
  await booking.getByLabel("Registration").fill("ab12 cde");
  await booking.getByRole("button", { name: "Find my car" }).click();
  await expect(booking.getByText("Vauxhall Astra", { exact: true })).toBeVisible();
  await booking.getByRole("button", { name: "Continue" }).click();
  await booking.waitForURL(/\/service$/);
  await booking.getByRole("radio", { name: /Interim service/ }).check();
  await booking.getByRole("button", { name: "Choose a time" }).click();
  await booking.waitForURL(/\/time/);
  await booking.locator(`[data-date="${day}"]`).click();
  await expect(booking).toHaveURL(new RegExp(`/time\\?date=${day}$`));
  await booking.locator("button[data-start]:not([disabled])").first().click();
  await booking.locator('button[form="time-form"]').click();
  await booking.waitForURL(/\/details$/);
}

test("fleet: the owner adds courtesy cars", async ({ browser }) => {
  const admin = await signedIn(browser);
  await admin.goto(`${adminOrigin}/app/courtesy-cars`);
  await expect(admin.getByRole("heading", { level: 1, name: "Courtesy cars", exact: true })).toBeVisible();
  await expect(admin.getByText("No courtesy cars yet")).toBeVisible();
  await checkScreen(admin);

  // A bad registration is refused with a plain message; nothing is saved.
  const add = admin.locator("#add-car");
  await add.getByLabel("Name").fill("Fiesta");
  await add.getByLabel("Registration").fill("!");
  await add.getByRole("button", { name: "Add car" }).click();
  await flashed(admin, "bad_car", "error");
  await expect(admin.getByRole("alert").filter({ hasText: "Check the car's name and registration" })).toBeVisible();

  await add.getByLabel("Name").fill("Fiesta");
  await add.getByLabel("Registration").fill("cc11 aaa");
  await add.getByLabel("Mileage (optional)").fill("12,000");
  await add.getByLabel("Fuel (optional)").selectOption({ label: "Full" });
  await add.getByRole("button", { name: "Add car" }).click();
  await flashed(admin, "car_added");
  await expect(admin.getByRole("status").filter({ hasText: "Car added." })).toBeVisible();
  // The registration is shown only as a plate chip, never in the address.
  await expect(admin.getByRole("heading", { level: 3, name: "Fiesta" })).toBeVisible();
  await expect(admin.getByText("CC11 AAA")).toBeVisible();
  expect(admin.url()).not.toMatch(/CC11/i);

  await add.getByLabel("Name").fill("Polo");
  await add.getByLabel("Registration").fill("CC22 BBB");
  await add.getByRole("button", { name: "Add car" }).click();
  await flashed(admin, "car_added");
  await expect(admin.getByRole("heading", { level: 3, name: "Polo" })).toBeVisible();
  const { data } = await service.from("courtesy_cars").select("registration").eq("garage_id", garage.id).order("registration");
  expect(data).toEqual([{ registration: "CC11AAA" }, { registration: "CC22BBB" }]);
});

test("service setting: collection and delivery for Interim service", async ({ browser }) => {
  const admin = await signedIn(browser);
  await admin.goto(`${adminOrigin}/app/settings/services/${serviceId}`);
  const panel = admin.locator("#collection-delivery");
  await expect(panel.getByRole("heading", { name: "Collection and delivery" })).toBeVisible();
  await expect(panel.getByRole("switch", { name: "Offer collection and delivery" })).toHaveAttribute("aria-checked", "false");
  await panel.getByRole("switch", { name: "Offer collection and delivery" }).click();
  await admin.waitForURL((url) => url.searchParams.get("collection") === "on", { timeout: 60_000 });
  await expect(admin.getByText("Collection and delivery is on for this service.")).toBeVisible();
  await expect(panel.getByRole("switch", { name: "Offer collection and delivery" })).toHaveAttribute("aria-checked", "true");
  await checkScreen(admin, "service-setting");
});

test("customer: books Interim service with a courtesy car request and collection", async ({ browser }) => {
  const context = await newCustomer(browser);
  const booking = await context.newPage();
  try {
    await toDetails(booking);
    const extras = booking.getByRole("group", { name: "Extras" });
    await expect(extras.getByRole("checkbox", { name: /I'd like a courtesy car/ })).toBeVisible();
    await expect(extras.getByRole("checkbox", { name: /Collect and deliver my car/ })).toBeVisible();
    await expect(booking.getByLabel("Address to collect from")).toBeHidden();
    await checkScreen(booking, "details");

    await extras.getByRole("checkbox", { name: /I'd like a courtesy car/ }).check();
    await extras.getByRole("checkbox", { name: /Collect and deliver my car/ }).check();
    await booking.getByLabel("Full name").fill("Cara Courtesy");
    await booking.getByLabel("Mobile number").fill("07700 900461");
    // Outside the van's area: refused on the field, nothing booked.
    await booking.getByLabel("Address to collect from").fill("1 High Street");
    await booking.getByLabel("Postcode").fill("S1 1AA");
    await booking.getByRole("button", { name: "Confirm booking" }).click();
    await expect(booking.getByText(/we don't collect from S1/)).toBeVisible();
    // Nothing the customer chose is lost while they fix the postcode.
    await expect(extras.getByRole("checkbox", { name: /I'd like a courtesy car/ })).toBeChecked();
    await expect(booking.getByLabel("Address to collect from")).toHaveValue("1 High Street");
    await booking.getByLabel("Postcode").fill("dn4 5aa");
    await booking.getByRole("button", { name: "Confirm booking" }).click();

    await booking.waitForURL(/\/confirmed\/[A-Z]+-\d{4,6}$/);
    const reference = booking.url().split("/").pop()!;
    // Booking state never puts the registration or the address in the URL.
    expect(booking.url()).not.toMatch(/AB12|DN4|High/i);
    const lines = booking.getByRole("list", { name: "Extras" });
    await expect(lines).toContainText("Courtesy car asked for: the garage will confirm it.");
    await expect(lines).toContainText("Collection and delivery booked");
    await checkScreen(booking, "confirmed");

    const { data: row } = await service.from("bookings").select("id").eq("garage_id", garage.id).eq("reference", reference).single();
    bookingId = String(row!.id);
    const { data: request } = await service.from("courtesy_car_requests").select("status,free_at_request").eq("booking_id", bookingId).single();
    expect(request).toEqual({ status: "open", free_at_request: true });
    const { data: legs } = await service.from("collection_delivery_legs").select("leg,status,postcode").eq("booking_id", bookingId).order("leg");
    expect(legs).toEqual([
      { leg: "collection", status: "held", postcode: "DN4 5AA" },
      { leg: "delivery", status: "held", postcode: "DN4 5AA" },
    ]);
  } finally {
    await context.close();
  }
});

test("staff: reserve the car from the booking, see the badge, check it out and in", async ({ browser }) => {
  const admin = await signedIn(browser);
  await admin.goto(`${adminOrigin}/app/courtesy-cars?week=${mondayOf(day)}`);
  const needs = admin.locator("#needs-ok");
  await expect(needs).toContainText("Courtesy car asked for by Cara Courtesy");
  await needs.getByRole("link", { name: /Choose a car/ }).click();
  await admin.waitForURL(new RegExp(`/app/bookings/${bookingId}`));

  const panel = admin.locator("#courtesy");
  await expect(panel).toContainText("The customer asked for a courtesy car.");
  await expect(panel.getByRole("radio", { name: /Fiesta/ })).toBeChecked();
  await expect(panel).toContainText("Collection");
  await panel.getByRole("button", { name: "Reserve courtesy car" }).click();
  await flashed(admin, "reserved");
  await expect(admin.getByRole("status").filter({ hasText: "Courtesy car reserved." })).toBeVisible();
  await expect(panel).toContainText("Reserved");
  await checkScreen(admin, "booking-panel");

  // The Diary marks the booking (phone list of the week).
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto(`${adminOrigin}/app/diary?week=${day}`);
  await expect(admin.locator("article").filter({ hasText: "Interim service" }).getByText("Courtesy car")).toBeVisible();
  await admin.setViewportSize({ width: 1440, height: 1000 });

  await admin.goto(`${adminOrigin}/app/bookings/${bookingId}`);
  await panel.getByText("Check out", { exact: false }).first().click();
  await panel.getByLabel("Mileage").fill("12000");
  await panel.getByLabel("Fuel", { exact: true }).selectOption({ label: "Full" });
  await panel.getByRole("button", { name: "Hand over Fiesta" }).click();
  await flashed(admin, "checked_out");
  await expect(admin.getByRole("status").filter({ hasText: "Checked out." })).toBeVisible();

  await panel.getByText("Check in", { exact: false }).first().click();
  await panel.getByLabel("Mileage").fill("11000");
  await panel.getByLabel("Fuel", { exact: true }).selectOption({ label: "3/4" });
  await panel.getByRole("button", { name: "Take back Fiesta" }).click();
  await flashed(admin, "INVALID_LOAN", "error");
  await expect(admin.getByRole("alert").filter({ hasText: "Some of the values can't be saved" })).toBeVisible();

  await panel.getByText("Check in", { exact: false }).first().click();
  await panel.getByLabel("Mileage").fill("12042");
  await panel.getByLabel("Fuel", { exact: true }).selectOption({ label: "3/4" });
  await panel.getByLabel(/Damage or problems/).fill("Small scratch on the rear bumper");
  await panel.getByRole("button", { name: "Take back Fiesta" }).click();
  await flashed(admin, "checked_in");
  await expect(admin.getByRole("status").filter({ hasText: "Checked in." })).toBeVisible();
  await expect(panel).toContainText("Returned");
  await expect(panel).toContainText("Damage: Small scratch on the rear bumper");

  const { data: loan } = await service.from("courtesy_car_loans").select("status,mileage_out,mileage_in,fuel_in").eq("booking_id", bookingId).single();
  expect(loan).toEqual({ status: "returned", mileage_out: 12000, mileage_in: 12042, fuel_in: 6 });

  await admin.goto(`${adminOrigin}/app/courtesy-cars?week=${mondayOf(day)}`);
  await expect(admin.locator("#van-runs")).toContainText("Collection");
  await expect(admin.locator("#van-runs")).toContainText("Delivery");
  await expect(admin.getByRole("list", { name: "Fiesta this week" })).toBeVisible();
  await checkScreen(admin, "fleet");
});

test("essentials: the page is locked and the booking site offers no extras", async ({ browser }) => {
  const { error } = await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  if (error) throw new Error(`Could not move the garage to Essentials: ${error.message}`);
  const admin = await signedIn(browser);
  // The plan is read with the admin context on each request.
  await admin.goto(`${adminOrigin}/app/courtesy-cars`);
  await expect(admin.getByRole("heading", { name: /Courtesy cars and collection is on Pro/ })).toBeVisible();
  await expect(admin.getByRole("button", { name: "Add car" })).toHaveCount(0);
  // What the garage added on Pro stays readable.
  await expect(admin.getByText("Everything you added on Pro is kept.")).toBeVisible();
  await expect(admin.getByText("Fiesta")).toBeVisible();
  await checkScreen(admin, "locked");

  await admin.goto(`${adminOrigin}/app/bookings/${bookingId}`);
  await expect(admin.locator("#courtesy").getByRole("button", { name: "Reserve courtesy car" })).toHaveCount(0);
  await expect(admin.locator("#courtesy").getByText("Check in")).toHaveCount(0);

  // The database refuses a Pro write from an Essentials garage too.
  const { error: rpcError } = await service.rpc("request_courtesy_car", { p_garage_id: garage.id, p_booking_id: bookingId });
  expect(rpcError?.message).toMatch(/^PLAN_REQUIRED: courtesy_cars/);

  const context = await newCustomer(browser);
  const booking = await context.newPage();
  try {
    await toDetails(booking);
    await expect(booking.getByRole("checkbox", { name: /courtesy car/i })).toHaveCount(0);
    await expect(booking.getByRole("checkbox", { name: /Collect and deliver/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
