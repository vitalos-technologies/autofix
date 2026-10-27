/**
 * Setup pages (P3.4): Services & prices, Opening hours, Bays & vans, Branding & MOT at /app/settings/*,
 * checked end to end against the garage's booking site. Runs under playwright.garage.config.ts (project
 * `settings`) against the production build and local Supabase.
 *
 * The spec makes its own garage (status active, MOT on, defaults from seed_garage_defaults()) and an owner
 * with a verified TOTP factor, signs in through the real password + MFA screens, and drives the booking site
 * on `<slug>.localhost`. So it never changes the demo garages the booking and manage specs use, and it
 * removes its garage (and everything in it) afterwards.
 *
 * Every setup page must have no axe violations at 390 and 1440 wide, and no horizontal page scroll.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { bookingAccent } from "../../src/lib/branding/accent";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const TIME_ZONE = "Europe/London";
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let owner: TotpMember;
let technician: TotpMember;
let admin: BrowserContext;
let page: Page;
let site: BrowserContext;
let booking: Page;
let siteOrigin: string;
let clientNumber = 0;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "s");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const { error: updateError } = await service.from("garages").update({ mot_enabled: true, service_area: ["DN1", "DN4"] }).eq("id", garage.id);
  if (updateError) throw new Error(`Could not set up the garage: ${updateError.message}`);
  const { error: seedError } = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (seedError) throw new Error(`Could not seed garage defaults: ${seedError.message}`);
  owner = await createTotpMember(service, garage.id, "owner", "settings-owner");
  technician = await createTotpMember(service, garage.id, "technician", "settings-technician");

  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await admin.newPage();
  await signInWithTotp(page, adminOrigin, owner);
  site = await newCustomer(browser);
  booking = await site.newPage();
});

test.afterAll(async () => {
  await admin?.close();
  await site?.close();
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  for (const member of [owner, technician]) if (member) await service.auth.admin.deleteUser(member.id);
});

/** Each customer context gets its own documentation-range address: the booking pages rate-limit per IP. */
async function newCustomer(browser: Browser) {
  clientNumber += 1;
  return browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${100 + clientNumber}` } });
}

async function expectAccessibleAt(target: Page, widths: number[] = [390, 1440]) {
  for (const width of widths) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    // Until P3.1 swaps in the new AdminShell, SOB's shell puts its own <main> inside the root layout's <main>.
    // Only while that nesting exists are the three landmark rules it breaks left out; everything else is checked.
    const nestedMain = await target.evaluate(() => document.querySelectorAll("main main").length > 0);
    const axe = new AxeBuilder({ page: target });
    if (nestedMain) axe.disableRules(["landmark-main-is-top-level", "landmark-no-duplicate-main", "landmark-unique"]);
    const results = await axe.analyze();
    expect(results.violations, `axe at ${width}px on ${new URL(target.url()).pathname}`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

/** The booking site's first two steps: find the (mock) car, go to the service step. */
async function openServiceStep() {
  await booking.goto(`${siteOrigin}/`);
  await booking.getByLabel("Registration").fill("ab12 cde");
  await booking.getByRole("button", { name: "Find my car" }).click();
  await expect(booking.getByText("Vauxhall Astra", { exact: true })).toBeVisible();
  await booking.getByRole("button", { name: "Continue" }).click();
  await booking.waitForURL(/\/service$/);
}

function serviceCard(name: RegExp) {
  return booking.locator("label").filter({ has: booking.getByRole("radio", { name }) });
}

/** A weekday (Mon to Fri) two to twelve days ahead in the garage's time zone: open by default and inside the time strip. */
function openWeekdayAhead() {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "short" });
  for (let days = 2; days <= 12; days += 1) {
    const instant = new Date(Date.now() + days * 86_400_000);
    if (!["Sat", "Sun"].includes(weekday.format(instant))) return format.format(instant);
  }
  throw new Error("No weekday ahead");
}

test("services: the owner changes a price and the booking site shows it", async () => {
  await page.goto(`${adminOrigin}/app/settings/services`);
  await expect(page.getByRole("heading", { level: 1, name: "Services & prices", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup pages" }).getByRole("link", { name: "Services & prices" })).toHaveAttribute("aria-current", "page");
  await expectAccessibleAt(page);

  await openServiceStep();
  await expect(serviceCard(/Diagnostics/)).toContainText("From £45");

  await page.getByRole("link", { name: "Edit Diagnostics" }).click();
  await page.waitForURL(/\/app\/settings\/services\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Edit Diagnostics", exact: true })).toBeVisible();
  await expectAccessibleAt(page);

  // Validation: a price that is not pounds and pence is refused, with the message on the field.
  await page.getByRole("radio", { name: "Fixed price" }).check({ force: true });
  await page.getByLabel("Price", { exact: true }).fill("forty");
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(page.getByText("Enter a price in pounds and pence")).toBeVisible();
  await expect(page.getByLabel("Price", { exact: true })).toBeFocused();

  await page.getByLabel("Price", { exact: true }).fill("49.50");
  await page.getByRole("button", { name: "Save service" }).click();
  await page.waitForURL(/\/app\/settings\/services\?done=updated$/);
  await expect(page.getByText("Service saved.")).toBeVisible();
  await expect(page.locator("#services li").filter({ hasText: "Diagnostics" })).toContainText("£49.50");

  await booking.reload();
  await expect(serviceCard(/Diagnostics/)).toContainText("£49.50");
  await expect(serviceCard(/Diagnostics/)).not.toContainText("From");

  await page.getByRole("link", { name: "Add a service" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a service", exact: true })).toBeVisible();
  await expectAccessibleAt(page);
});

test("hours: a closure takes that day off the booking site's time step", async () => {
  const day = openWeekdayAhead();
  await page.goto(`${adminOrigin}/app/settings/hours`);
  await expect(page.getByRole("heading", { level: 1, name: "Opening hours", exact: true })).toBeVisible();
  await expectAccessibleAt(page);

  await openServiceStep();
  await booking.getByRole("radio", { name: /Full service/ }).check();
  await booking.getByRole("button", { name: "Choose a time" }).click();
  await booking.waitForURL(/\/time/);
  await expect(booking.locator(`[data-date="${day}"]`)).toBeEnabled();

  // Validation: the last day can't be before the first.
  await page.getByLabel("First day closed").fill(day);
  await page.getByLabel("Last day closed").fill("2020-01-01");
  await page.getByRole("button", { name: "Add closure" }).click();
  await expect(page.getByText("The last day must be on or after the first day.")).toBeVisible();

  await page.getByLabel("Last day closed").fill(day);
  await page.getByLabel("Reason (optional)").fill("Training day");
  await page.getByRole("button", { name: "Add closure" }).click();
  await expect(page.getByText("Closure added.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Upcoming closures" })).toContainText("Training day");

  await booking.reload();
  await expect(booking.locator(`[data-date="${day}"]`)).toBeDisabled();
});

test("hours: overlapping opening times are refused, a split day is saved", async () => {
  await page.goto(`${adminOrigin}/app/settings/hours`);
  const monday = page.getByRole("group", { name: "Monday" });
  await monday.getByRole("button", { name: /Add more hours/ }).click();
  await monday.getByLabel("Opens").nth(1).fill("12:00");
  await monday.getByLabel("Closes").nth(1).fill("18:00");
  await expect(monday.getByText("The hours on Monday overlap.")).toBeVisible();
  await page.getByRole("button", { name: "Save opening hours" }).click();
  await expect(page.getByText("Check the highlighted days.")).toBeVisible();

  await monday.getByLabel("Closes").nth(0).fill("12:00");
  await monday.getByLabel("Opens").nth(1).fill("13:00");
  await page.getByRole("button", { name: "Save opening hours" }).click();
  await expect(page.getByText("Opening hours saved.")).toBeVisible();
  const { data } = await service.from("opening_hours").select("opens,closes").eq("garage_id", garage.id).eq("weekday", 1).order("opens");
  expect(data).toEqual([{ opens: "08:00:00", closes: "12:00:00" }, { opens: "13:00:00", closes: "18:00:00" }]);
});

test("resources: bays and vans are listed with switches", async () => {
  await page.goto(`${adminOrigin}/app/settings/resources`);
  await expect(page.getByRole("heading", { level: 1, name: "Bays & vans", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Bay 1 takes bookings" })).toHaveAttribute("aria-checked", "true");
  await expectAccessibleAt(page);

  await page.getByRole("radio", { name: "Bay" }).check({ force: true });
  await page.getByLabel("Name", { exact: true }).fill("Bay 4");
  await page.getByRole("button", { name: "Add bay" }).click();
  await expect(page.getByText("Bay 4 added.")).toBeVisible();
  await page.getByRole("switch", { name: "Bay 4 takes bookings" }).click();
  await expect(page.getByRole("switch", { name: "Bay 4 takes bookings" })).toHaveAttribute("aria-checked", "false");
});

test("branding: #ffcc00 is darkened until white text passes, and the booking site uses it", async () => {
  const darkened = bookingAccent("#ffcc00");
  expect(darkened).not.toBe("#ffcc00");
  await page.goto(`${adminOrigin}/app/settings/branding`);
  await expect(page.getByRole("heading", { level: 1, name: "Branding & MOT", exact: true })).toBeVisible();
  await expectAccessibleAt(page);

  await page.getByRole("button", { name: "Custom colour" }).click();
  await page.getByLabel("Hex code").fill("#ffcc00");
  await expect(page.getByText(/White text on #ffcc00 is \d\.\d:1, below the 4\.5:1 needed/)).toBeVisible();
  await expect(page.getByText(`We'll save it as ${darkened}`, { exact: false })).toBeVisible();
  await expectAccessibleAt(page);
  await page.getByRole("button", { name: "Save colour" }).click();
  await expect(page.getByText(`Saved as ${darkened}.`)).toBeVisible();
  const { data } = await service.from("garages").select("accent").eq("id", garage.id).single();
  expect(data?.accent).toBe(darkened);

  await booking.goto(`${siteOrigin}/`);
  const accent = await booking.locator("[data-garage]").evaluate((element) => getComputedStyle(element).getPropertyValue("--garage-accent").trim());
  expect(accent).toBe(darkened);
  const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(darkened.slice(start, start + 2), 16));
  await booking.getByLabel("Registration").fill("ab12 cde");
  await booking.getByRole("button", { name: "Find my car" }).click();
  await expect(booking.getByText("Vauxhall Astra", { exact: true })).toBeVisible();
  await expect(booking.getByRole("button", { name: "Continue" })).toHaveCSS("background-color", `rgb(${red}, ${green}, ${blue})`);
});

test("branding: the owner uploads a logo to the garage's folder and the booking header shows it", async () => {
  await page.goto(`${adminOrigin}/app/settings/branding`);
  await page.getByLabel("Upload a logo").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
  await page.getByRole("button", { name: "Upload logo" }).click();
  await expect(page.getByText("Upload a PNG, JPEG or WebP image.").first()).toBeVisible();

  await page.getByLabel("Upload a logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Upload logo" }).click();
  await expect(page.getByText("Logo saved.")).toBeVisible();
  await expect(page.getByRole("img", { name: `${garage.name} logo` })).toBeVisible();

  await booking.goto(`${siteOrigin}/`);
  await expect(booking.locator("header img").first()).toHaveAttribute("src", new RegExp(`/public-media/${garage.id}/logo\\.png\\?v=\\d+$`));
});

test("MOT: switching it off removes the MOT service from the booking site", async () => {
  await openServiceStep();
  await expect(booking.getByRole("radio", { name: /^MOT\b/ })).toHaveCount(1);

  await page.goto(`${adminOrigin}/app/settings/branding#mot`);
  const mot = page.getByRole("switch", { name: "Offer MOTs" });
  await expect(mot).toHaveAttribute("aria-checked", "true");
  await mot.click();
  await expect(page.getByText("MOT is off.")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Offer MOTs" })).toHaveAttribute("aria-checked", "false");
  await expectAccessibleAt(page);

  await booking.reload();
  await expect(booking.getByRole("radio", { name: /Diagnostics/ })).toBeVisible();
  await expect(booking.getByRole("radio", { name: /^MOT\b/ })).toHaveCount(0);

  await page.goto(`${adminOrigin}/app/settings/services`);
  await expect(page.getByText("MOT is switched off, so MOT services are hidden from customers.")).toBeVisible();
});

test("a technician sees setup read only", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const tech = await context.newPage();
    await signInWithTotp(tech, adminOrigin, technician);
    await tech.goto(`${adminOrigin}/app/settings/services`);
    await expect(tech.getByText("You can see these settings. Owners and managers can change them.")).toBeVisible();
    await expect(tech.getByRole("link", { name: "Add a service" })).toHaveCount(0);
    await expect(tech.getByRole("link", { name: /^Edit / })).toHaveCount(0);
    await expect(tech.getByRole("button", { name: /^Archive/ })).toHaveCount(0);
    await expectAccessibleAt(tech, [390]);

    await tech.goto(`${adminOrigin}/app/settings/hours`);
    await expect(tech.getByRole("button", { name: "Save opening hours" })).toHaveCount(0);
    await expect(tech.getByRole("group", { name: "Monday" }).getByLabel("Opens").first()).toBeDisabled();

    await tech.goto(`${adminOrigin}/app/settings/branding`);
    await expect(tech.getByText("Only the garage owner can change them.")).toBeVisible();
    await expect(tech.getByRole("switch", { name: "Offer MOTs" })).toBeDisabled();
    await expect(tech.getByRole("button", { name: "Save colour" })).toHaveCount(0);
    await expectAccessibleAt(tech, [390]);
  } finally {
    await context.close();
  }
});
