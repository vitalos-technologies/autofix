/**
 * Garage admin journeys (P3.1–P3.3) on the admin host, run by playwright.garage.config.ts (projects
 * `admin-chromium` at 1440 and `admin-390` at 390 × 844) against the production build, local
 * Supabase, the demo seed (`pnpm db:seed`) and the database engine:
 *   - a hartley-road owner signs in with password + TOTP and Today shows the day's bookings;
 *   - accepting a request on Today confirms it (the trigger writes the timeline event as them);
 *   - changing a status and adding a note on the booking page land in its history;
 *   - search posts the registration (never in a URL) and finds the booking;
 *   - a staff phone booking goes through the engine;
 *   - the diary week view and its navigation;
 *   - a manager of two garages switches garage.
 * Each run makes its own staff users (with TOTP) and bookings, and removes them afterwards.
 * axe runs on every screen with zero violations allowed.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createRequestBooking,
  createStaffUser,
  createTodayBooking,
  deleteBookings,
  deleteStaffUsers,
  nextCode,
  type StaffUser,
  type TodayFixture,
} from "../helpers/admin-session";
import { seededGarage, serviceClient, type SeededGarage } from "../helpers/booking-fixtures";

test.describe.configure({ mode: "serial" });

let hartley: SeededGarage;
let demoB: SeededGarage;
let owner: StaffUser;
let manager: StaffUser;
let context: BrowserContext;
let page: Page;
const bookings: string[] = [];
const users: StaffUser[] = [];
const fixtures: Record<"ready" | "inBay" | "parts" | "booked" | "request", TodayFixture> = {} as never;
const urls: string[] = [];

function compact(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function spaced(registration: string) {
  return registration.length === 7 ? `${registration.slice(0, 4)} ${registration.slice(4)}` : registration;
}

async function expectAccessible(target: Page) {
  await expect(target).toHaveTitle(/\S/);
  await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page: target }).analyze();
  expect(results.violations).toEqual([]);
  await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

function isPhone(target: Page) {
  return (target.viewportSize()?.width ?? 1440) < 1024;
}

/** The bookings list's own Search button (phones also have the header's search toggle). */
function listSearch(target: Page) {
  return target.locator("form").filter({ has: target.getByLabel("Reference, name, mobile or registration") }).getByRole("button", { name: "Search", exact: true });
}

/** The project's browser settings (viewport, device, baseURL) for contexts made outside a test. */
function contextOptions(use: Record<string, unknown>) {
  const pick = ["baseURL", "viewport", "userAgent", "deviceScaleFactor", "isMobile", "hasTouch"] as const;
  return Object.fromEntries(pick.filter((key) => use[key] !== undefined).map((key) => [key, use[key]]));
}

let options: Record<string, unknown> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  options = contextOptions(testInfo.project.use as Record<string, unknown>);
  const origin = String(options.baseURL ?? "http://localhost:3430");
  [hartley, demoB] = await Promise.all([seededGarage("hartley-road"), seededGarage("demo-b")]);
  owner = await createStaffUser("owner", "Dan Morris", [{ garageId: hartley.id, role: "owner" }], origin);
  manager = await createStaffUser("shared", "Alex Shared", [{ garageId: hartley.id, role: "manager" }, { garageId: demoB.id, role: "manager" }], origin);
  users.push(owner, manager);

  fixtures.ready = await createTodayBooking(hartley, { service: "Full service", minutes: 8 * 60 + 30, status: "ready", customerName: "Amelia Test", make: "Vauxhall", model: "Astra" });
  fixtures.inBay = await createTodayBooking(hartley, { service: "Diagnostics", minutes: 10 * 60, status: "in_progress", customerName: "Sarah Test", make: "Ford", model: "Focus" });
  fixtures.parts = await createTodayBooking(hartley, { service: "Interim service", minutes: 9 * 60 + 30, status: "waiting_parts", customerName: "Oscar Test", make: "Nissan", model: "Qashqai" });
  fixtures.booked = await createTodayBooking(hartley, { service: "Diagnostics", minutes: 11 * 60, status: "confirmed", customerName: "Ava Test", make: "VW", model: "Polo" });
  fixtures.request = await createRequestBooking(hartley, "James Test");
  bookings.push(...Object.values(fixtures).map((fixture) => fixture.id));

  context = await browser.newContext(options);
  page = await context.newPage();
  page.on("request", (request) => urls.push(request.url()));
});

test.afterAll(async () => {
  await context?.close();
  await deleteBookings(bookings);
  await deleteStaffUsers(users);
});

test("an owner signs in with password and TOTP and Today shows the day's bookings", async () => {
  test.setTimeout(90_000);
  await page.goto("/app/login");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/mfa(?:\?.*)?$/);
  await page.getByLabel("Verification code").fill(await nextCode(owner));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/app\/?$/);

  await expect(page.locator("h1:visible")).toHaveCount(1);
  if (isPhone(page)) {
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Today at a glance" })).toContainText(/\d+ cars?/);
    for (const fixture of [fixtures.ready, fixtures.inBay, fixtures.parts, fixtures.booked]) {
      await expect(page.locator("article:visible").filter({ hasText: spaced(fixture.registration) })).toBeVisible();
    }
    // The car in the bay has its next steps on the card.
    await expect(page.getByRole("button", { name: `Mark ready for ${spaced(fixtures.inBay.registration)}` })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
  } else {
    await expect(page.getByRole("heading", { level: 1, name: /, Dan\. \d+ cars? in today\.$/ })).toBeVisible();
    const diary = page.getByRole("region", { name: "Today's diary, by bay" });
    for (const fixture of [fixtures.ready, fixtures.inBay, fixtures.parts, fixtures.booked]) {
      await expect(diary.getByRole("link", { name: new RegExp(`^${spaced(fixture.registration)}, `) })).toBeVisible();
    }
    await expect(page.getByRole("group", { name: "Today at a glance" }).getByText("In the workshop")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reminders this week" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  }
  await expectAccessible(page);
});

test("accepting a request on Today confirms it, as the signed-in member", async () => {
  await page.goto("/app");
  const accept = page.getByRole("button", { name: `Accept for ${spaced(fixtures.request.registration)}, ${fixtures.request.customerName}` }).filter({ visible: true });
  await expect(accept).toBeVisible();
  await accept.click();
  await expect(page.getByRole("button", { name: `Accept for ${spaced(fixtures.request.registration)}, ${fixtures.request.customerName}` }).filter({ visible: true })).toHaveCount(0);

  const { data: booking } = await serviceClient().from("bookings").select("status,admin_seen_at").eq("id", fixtures.request.id).single();
  expect(booking).toMatchObject({ status: "confirmed" });
  expect(booking?.admin_seen_at).not.toBeNull();
  const { data: events } = await serviceClient().from("booking_events").select("type,actor,actor_id,data").eq("booking_id", fixtures.request.id).eq("type", "status_changed");
  expect(events).toEqual([expect.objectContaining({ actor: "staff", actor_id: owner.id, data: { from: "requested", to: "confirmed" } })]);
  await expectAccessible(page);
});

test("changing a status and adding a note on the booking page land in its history", async () => {
  await page.goto(`/app/bookings/${fixtures.inBay.id}`);
  await expect(page.getByRole("heading", { level: 1, name: fixtures.inBay.customerName })).toBeVisible();
  await expect(page.locator("h1:visible")).toHaveCount(1);
  const history = page.getByRole("list", { name: "Booking history, newest first" });

  await page.getByRole("button", { name: `Mark ready for booking ${fixtures.inBay.reference}` }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked ready to collect." })).toBeVisible();
  await expect(history.getByRole("listitem").first()).toContainText("Status: Ready");
  await expect(history.getByRole("listitem").first()).toContainText("In bay → Ready");
  await expect(history.getByRole("listitem").first()).toContainText("You");

  await page.getByLabel("Add a note").fill("Customer collecting after 5.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(history.getByRole("listitem").first()).toContainText("Customer collecting after 5.");
  const { data: note } = await serviceClient().from("booking_events").select("actor,actor_id,data").eq("booking_id", fixtures.inBay.id).eq("type", "note").single();
  expect(note).toEqual({ actor: "staff", actor_id: owner.id, data: { text: "Customer collecting after 5." } });
  await expectAccessible(page);
});

test("search posts a registration, keeps it out of every URL and finds the booking", async () => {
  await page.goto("/app/bookings");
  await expect(page.getByRole("heading", { level: 1, name: "Bookings" })).toBeVisible();
  await page.getByLabel("Reference, name, mobile or registration").fill(spaced(fixtures.parts.registration));
  await listSearch(page).click();
  await expect(page).toHaveURL(/\/app\/bookings\?search=1$/);
  await expect(page.getByRole("status").filter({ hasText: /^1 booking matching/ })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(fixtures.parts.reference) }).filter({ visible: true })).toBeVisible();
  await expectAccessible(page);

  // A reference opens the booking itself.
  await page.getByLabel("Reference, name, mobile or registration").fill(fixtures.booked.reference.toLowerCase());
  await listSearch(page).click();
  await expect(page).toHaveURL(new RegExp(`/app/bookings/${fixtures.booked.id}$`));

  const leaks = urls.filter((url) => [fixtures.parts, fixtures.ready, fixtures.inBay, fixtures.booked, fixtures.request].some((fixture) => compact(decodeURIComponent(url)).includes(compact(fixture.registration))));
  expect(leaks, "registration in a URL").toEqual([]);
});

test("staff book a phone customer in through the booking engine", async () => {
  test.setTimeout(60_000);
  await page.goto("/app/bookings/new");
  await expect(page.getByRole("heading", { level: 1, name: "New booking" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("textbox", { name: "Registration" }).fill("MT22 PHN");
  const diagnostics = await page.locator("select option", { hasText: /^Diagnostics/ }).first().getAttribute("value");
  await page.getByLabel("Service", { exact: true }).selectOption(diagnostics ?? "");
  // First open day with a free time.
  const days = page.getByRole("group", { name: "Day", exact: true }).getByRole("button");
  const free = page.locator("button[data-start]:not([disabled])");
  for (let index = 0; index < 10; index += 1) {
    const day = days.nth(index);
    if (await day.isDisabled()) continue;
    await day.click();
    await expect(page.getByText("Finding free times…")).toHaveCount(0);
    if ((await free.count()) > 0) break;
  }
  await free.first().click();
  await page.getByLabel("Name", { exact: true }).fill("Phone Test Customer");
  await page.getByLabel("Mobile", { exact: true }).fill("07700 900488");
  await page.getByRole("button", { name: /^Book in for / }).click();
  await expect(page).toHaveURL(/\/app\/bookings\/[0-9a-f-]{36}\?notice=created$/);
  const id = /bookings\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  bookings.push(id);
  await expect(page.getByRole("status").filter({ hasText: "Booking made." })).toBeVisible();
  const { data } = await serviceClient().from("bookings").select("source,garage_id,status").eq("id", id).single();
  expect(data).toEqual({ source: "phone", garage_id: hartley.id, status: "confirmed" });
  await expectAccessible(page);
});

test("the diary shows the week by bay and moves between weeks", async () => {
  await page.goto("/app/diary");
  await expect(page.getByRole("heading", { level: 1, name: "Diary" })).toBeVisible();
  if (isPhone(page)) {
    const today = page.locator("section:visible").filter({ has: page.getByRole("heading", { name: /Today$/ }) });
    await expect(today.locator("article").filter({ hasText: spaced(fixtures.booked.registration) })).toBeVisible();
  } else {
    const week = page.getByRole("region", { name: /^Bookings for the week of/ });
    await expect(week.getByRole("columnheader", { name: /Today/ })).toBeVisible();
    await expect(week.getByRole("link", { name: new RegExp(spaced(fixtures.booked.registration)) })).toBeVisible();
  }
  await expectAccessible(page);

  const eyebrow = page.getByText(/^Week of /).filter({ visible: true }).first();
  const thisWeek = await eyebrow.textContent();
  await page.getByRole("link", { name: "Next week" }).click();
  await expect(page).toHaveURL(/\/app\/diary\?week=\d{4}-\d{2}-\d{2}$/);
  await expect(eyebrow).not.toHaveText(thisWeek ?? "");
  await page.getByRole("link", { name: "This week" }).click();
  await expect(eyebrow).toHaveText(thisWeek ?? "");

  // One day on the diary grid.
  await page.goto(`/app/diary?day=${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date())}`);
  await expect(page.getByRole("region", { name: "Today's diary, by bay" })).toBeVisible();
  await expectAccessible(page);
});

test("a manager of two garages switches garage", async ({ browser }) => {
  const managerContext = await browser.newContext(options);
  try {
    await managerContext.addCookies(manager.cookies);
    const managerPage = await managerContext.newPage();
    if (isPhone(managerPage)) {
      await managerPage.goto("/app/more");
      await expect(managerPage.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
      await expectAccessible(managerPage);
    } else {
      await managerPage.goto("/app");
    }
    const switcher = managerPage.locator("summary:visible").filter({ hasText: "Switch garage. Current:" });
    await expect(switcher).toContainText(hartley.name);
    await switcher.click();
    await managerPage.getByRole("button", { name: demoB.name }).filter({ visible: true }).click();
    await expect(managerPage).toHaveURL(/\/app\/?$/);
    // Hartley Road's cars are not in Demo Garage B's day.
    await expect(managerPage.locator("h1:visible")).toHaveCount(1);
    await expect(managerPage.getByText(spaced(fixtures.booked.registration))).toHaveCount(0);
    if (isPhone(managerPage)) await managerPage.goto("/app/more");
    await expect(managerPage.locator("summary:visible").filter({ hasText: "Switch garage. Current:" })).toContainText(demoB.name);
    expect((await managerContext.cookies()).find((cookie) => cookie.name === "af_garage")).toMatchObject({ value: demoB.id, httpOnly: true });
    await expectAccessible(managerPage);
  } finally {
    await managerContext.close();
  }
});
