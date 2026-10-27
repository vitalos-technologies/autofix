/**
 * Garage admin journeys (P3.1–P3.3) on the admin host, run by playwright.garage.config.ts (projects
 * `admin-chromium` at 1440 and `admin-390` at 390 × 844) against the production build, local
 * Supabase, the demo seed (`pnpm db:seed`) and the database engine:
 *   - a hartley-road owner signs in with password + TOTP and Today shows the day's bookings;
 *   - accepting a request on Today confirms it (the trigger writes the timeline event as them);
 *   - changing a status and adding a note on the booking page land in its history;
 *   - search posts the registration (never in a URL) and finds the booking;
 *   - a staff phone booking goes through the engine, and one outside opening hours for a service not offered online;
 *   - the diary week view and its navigation;
 *   - a manager of two garages switches garage (and Demo Garage B, no MOTs, has no MOT reminders);
 *   - a missed call on Today's "Needs your OK": text-back badge, call back, voicemail, mark handled (P4.1 data);
 *   - Reminders (P3.10): this month, the automations, what's due, review requests only after the
 *     consent note, the editor refusing unknown placeholders, "Send me a test", read only for technicians.
 * Each run makes its own staff users (with TOTP), bookings, customers, cars, reminder sends and calls,
 * removes them afterwards and puts hartley-road's reminder rules back as they were.
 * axe runs on every screen with zero violations allowed.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createDueReminders,
  createMissedCall,
  createOfflineService,
  createRequestBooking,
  createStaffUser,
  createTodayBooking,
  deleteBookings,
  deleteReminderFixtures,
  deleteServices,
  deleteStaffUsers,
  emptyCleanup,
  nextCode,
  restoreReminderRules,
  snapshotReminderRules,
  type DueFixture,
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
const services: string[] = [];
const users: StaffUser[] = [];
const fixtures: Record<"ready" | "inBay" | "parts" | "booked" | "request", TodayFixture> = {} as never;
const urls: string[] = [];
const reminderCleanup = emptyCleanup();
let rulesBefore: Awaited<ReturnType<typeof snapshotReminderRules>> = [];
let due: { consenting: DueFixture; declined: DueFixture };

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
  rulesBefore = await snapshotReminderRules(hartley.id);
  due = await createDueReminders(hartley, reminderCleanup);

  context = await browser.newContext(options);
  page = await context.newPage();
  page.on("request", (request) => urls.push(request.url()));
});

test.afterAll(async () => {
  await context?.close();
  await deleteBookings(bookings);
  await deleteServices(services);
  await deleteReminderFixtures(reminderCleanup);
  if (rulesBefore.length) await restoreReminderRules(hartley.id, rulesBefore);
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

test("staff book a service that isn't offered online, outside opening hours", async () => {
  test.setTimeout(60_000);
  const offline = await createOfflineService(hartley);
  services.push(offline.id);
  await page.goto("/app/bookings/new");
  await page.getByRole("textbox", { name: "Registration" }).fill("MT22 OOH");
  const option = page.locator("select option", { hasText: offline.name });
  await expect(option).toHaveText(new RegExp(`^${offline.name} · .* · not offered online$`));
  await page.getByLabel("Service", { exact: true }).selectOption((await option.getAttribute("value")) ?? "");

  const override = page.getByRole("checkbox", { name: "Outside opening hours" });
  await expect(override).toHaveAccessibleDescription("Books a time the garage is normally closed. Bays must still be free.");
  await expect(page.getByLabel("Date and time")).toHaveCount(0);
  await override.check();
  // Three days ahead at 06:15 garage time: before any opening hours.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + 3 * 86_400_000));
  await page.getByLabel("Date and time").fill(`${day}T06:15`);
  await expect(page.getByRole("button", { name: /^Book in for .*, 06:15$/ })).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Name", { exact: true }).fill("Early Dropoff Test");
  await page.getByLabel("Mobile", { exact: true }).fill("07700 900489");
  await page.getByRole("button", { name: /^Book in for / }).click();
  await expect(page).toHaveURL(/\/app\/bookings\/[0-9a-f-]{36}\?notice=created$/);
  const id = /bookings\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  bookings.push(id);
  const { data } = await serviceClient().from("bookings").select("source,garage_id,status,service_id,starts_at").eq("id", id).single();
  expect(data).toMatchObject({ source: "phone", garage_id: hartley.id, status: "confirmed", service_id: offline.id });
  expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(String(data?.starts_at)))).toBe("06:15");
  const { data: created } = await serviceClient().from("booking_events").select("actor,actor_id,data").eq("booking_id", id).eq("type", "created").single();
  expect(created).toMatchObject({ actor: "staff", actor_id: owner.id, data: expect.objectContaining({ hours_override: true }) });
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

    // Demo Garage B doesn't do MOTs: no MOT automation, and Hartley Road's cars aren't due here.
    await managerPage.goto("/app/reminders");
    await expect(managerPage.getByRole("heading", { level: 1, name: "Reminders" })).toBeVisible();
    await expect(managerPage.getByRole("switch", { name: "Service due reminders" })).toBeVisible();
    await expect(managerPage.getByRole("switch", { name: "MOT due reminders" })).toHaveCount(0);
    await expect(managerPage.getByText(due.consenting.customerName)).toHaveCount(0);
  } finally {
    await managerContext.close();
  }
});

test("a missed call waits on Today until someone marks it handled", async () => {
  const call = await createMissedCall(hartley, "Rhys Callertest", reminderCleanup);
  await page.goto("/app");
  if (isPhone(page)) await expect(page.getByRole("region", { name: "Today at a glance" }).getByRole("link", { name: /^\d+ missed calls?$/ })).toBeVisible();
  const card = page.getByRole("article", { name: new RegExp(`^${call.callerName}`) }).filter({ visible: true });
  await expect(card).toBeVisible();
  await expect(card.getByText("Missed call", { exact: true })).toBeVisible();
  await expect(card.getByText("Texted back")).toBeVisible();
  await expect(card).toContainText(`07••• •••${call.fromNumber.slice(-3)}`);
  await expect(card).not.toContainText(call.fromNumber.slice(3));
  await expect(card.getByRole("link", { name: `Call back ${call.callerName}` })).toHaveAttribute("href", `tel:${call.fromNumber}`);
  await expectAccessible(page);

  // The recording is only fetched when asked for (locally there are no Twilio credentials).
  expect(urls.some((url) => url.includes(`/api/admin/calls/${call.id}/voicemail`))).toBe(false);
  await card.getByRole("button", { name: "Play voicemail (0:42)" }).click();
  await expect(card.locator("audio").or(card.getByText("The voicemail couldn't be played. Try again later."))).toBeVisible();
  await expect.poll(() => urls.some((url) => url.includes(`/api/admin/calls/${call.id}/voicemail`))).toBe(true);

  await card.getByRole("button", { name: `Mark handled: call from ${call.callerName}` }).click();
  await expect(page.getByRole("article", { name: new RegExp(`^${call.callerName}`) }).filter({ visible: true })).toHaveCount(0);
  const { data } = await serviceClient().from("calls").select("handled_at,handled_by").eq("id", call.id).single();
  expect(data?.handled_by).toBe(owner.id);
  expect(data?.handled_at).not.toBeNull();
});

test("Reminders shows this month, the automations and what's due in the next 30 days", async () => {
  await page.goto("/app/reminders");
  await expect(page.getByRole("heading", { level: 1, name: "Reminders" })).toBeVisible();
  await expect(page.locator("h1:visible")).toHaveCount(1);
  const month = page.getByRole("group", { name: "This month" });
  for (const label of ["Sent this month", "Booked from a reminder", "Revenue won back", "Opted out"]) await expect(month.getByText(label)).toBeVisible();
  for (const name of ["MOT due reminders", "Service due reminders", "Missed-call text-back", "Review requests"]) await expect(page.getByRole("switch", { name })).toBeVisible();
  await expect(page.getByRole("switch", { name: "MOT due reminders" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("28 days and 7 days before the MOT runs out · dates checked against DVSA nightly")).toBeVisible();

  const table = page.getByRole("table", { name: "MOTs and services due in the next 30 days" });
  const consenting = table.getByRole("row").filter({ hasText: due.consenting.customerName });
  await expect(consenting).toContainText(spaced(due.consenting.registration));
  await expect(consenting).toContainText("MOT");
  await expect(consenting).toContainText(/Sent \d{1,2} [A-Z][a-z]{2}/);
  await expect(consenting.getByRole("link", { name: due.consenting.customerName })).toHaveAttribute("href", `/app/customers/${due.consenting.customerId}`);
  await expect(table.getByRole("row").filter({ hasText: due.declined.customerName })).toContainText("No consent, won't send");

  const preview = page.getByRole("complementary", { name: "Message preview" });
  await expect(preview).toContainText(/Hi Priya, MOT due \d{1,2} [A-Z][a-z]{2}\. Book:/);
  await expect(preview).toContainText("Reply STOP to opt out.");
  await expectAccessible(page);
});

test("switches save, and review requests only go on after the consent note", async () => {
  await page.goto("/app/reminders");
  const service = page.getByRole("switch", { name: "Service due reminders" });
  await service.click();
  await expect(page).toHaveURL(/\/app\/reminders\?done=service_off$/);
  await expect(page.getByRole("status").filter({ hasText: "Service due reminders switched off." })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Service due reminders" })).toHaveAttribute("aria-checked", "false");
  const rule = (kind: string) => serviceClient().from("reminder_rules").select("enabled").eq("garage_id", hartley.id).eq("kind", kind).single();
  expect((await rule("service")).data).toEqual({ enabled: false });
  await page.getByRole("switch", { name: "Service due reminders" }).click();
  await expect(page.getByRole("switch", { name: "Service due reminders" })).toHaveAttribute("aria-checked", "true");

  await expect(page.getByRole("switch", { name: "Review requests" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Review requests" }).click();
  await expect(page).toHaveURL(/\/app\/reminders\?confirm=review#review-confirm$/);
  const confirm = page.getByRole("region", { name: "Switch on review requests?" });
  await expect(confirm).toContainText("That wording doesn't mention review requests, so check with your solicitor that it covers them before you switch this on.");
  expect((await rule("review")).data).toEqual({ enabled: false });
  await expectAccessible(page);
  await confirm.getByRole("link", { name: "Keep them off" }).click();
  await expect(page.getByRole("region", { name: "Switch on review requests?" })).toHaveCount(0);
  expect((await rule("review")).data).toEqual({ enabled: false });

  await page.getByRole("switch", { name: "Review requests" }).click();
  await page.getByRole("region", { name: "Switch on review requests?" }).getByRole("button", { name: "Switch on review requests" }).click();
  await expect(page).toHaveURL(/\/app\/reminders\?done=review_on$/);
  await expect(page.getByRole("switch", { name: "Review requests" })).toHaveAttribute("aria-checked", "true");
  expect((await rule("review")).data).toEqual({ enabled: true });
  await page.getByRole("switch", { name: "Review requests" }).click();
  await expect(page.getByRole("switch", { name: "Review requests" })).toHaveAttribute("aria-checked", "false");
});

test("the editor refuses placeholders the sender can't fill, saves good wording and sends a test", async () => {
  await page.goto("/app/reminders");
  await page.getByRole("link", { name: "Edit MOT due" }).click();
  await expect(page).toHaveURL(/\/app\/reminders\?edit=mot#rule-editor$/);
  const editor = page.getByRole("region", { name: "Edit: MOT due" });
  const message = editor.getByRole("textbox", { name: "Message" });
  const before = (await serviceClient().from("reminder_rules").select("template").eq("garage_id", hartley.id).eq("kind", "mot").single()).data?.template;
  await expect(message).toHaveValue(before ?? "");

  await message.fill("Hi {frist_name}, your MOT is due on {due_date}. Book: {link}\n{garage}");
  await expect(editor.getByText("{frist_name} isn't a placeholder this message can fill in.", { exact: false })).toBeVisible();
  await expect(message).toHaveAttribute("aria-invalid", "true");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("alert").filter({ hasText: "Check the highlighted fields." })).toBeVisible();
  expect((await serviceClient().from("reminder_rules").select("template").eq("garage_id", hartley.id).eq("kind", "mot").single()).data?.template).toBe(before);
  await expectAccessible(page);

  await message.fill("Hi , your MOT is due on {due_date}. Book: {link}\n{garage}");
  await message.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(3, 3));
  await editor.getByRole("button", { name: "{first_name}" }).click();
  await expect(message).toHaveValue("Hi {first_name}, your MOT is due on {due_date}. Book: {link}\n{garage}");
  await expect(message).not.toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByText(/(of 160 characters · 1 text|characters · \d texts) \(with sample details\)/)).toBeVisible();
  await editor.getByLabel("Days before the MOT runs out").fill("30, 7");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("status").filter({ hasText: "MOT due saved." })).toBeVisible();
  const { data: saved } = await serviceClient().from("reminder_rules").select("template,offset_days").eq("garage_id", hartley.id).eq("kind", "mot").single();
  expect(saved).toEqual({ template: "Hi {first_name}, your MOT is due on {due_date}. Book: {link}\n{garage}", offset_days: [30, 7] });

  await editor.getByRole("button", { name: "Send me a test" }).click();
  await expect(editor.getByRole("status").filter({ hasText: /^Test made for your email \(a•••@example\.test\)\. Messaging is in test mode/ })).toBeVisible();
  const { data: audit } = await serviceClient().from("admin_audit_log").select("action,detail").eq("garage_id", hartley.id).eq("actor_id", owner.id).eq("action", "reminder.test_sent");
  expect(audit).toEqual([{ action: "reminder.test_sent", detail: { kind: "mot", outcome: "sent", channel: "email" } }]);
  await expectAccessible(page);

  const leaks = urls.filter((url) => [due.consenting, due.declined].some((fixture) => compact(decodeURIComponent(url)).includes(compact(fixture.registration))));
  expect(leaks, "registration in a URL").toEqual([]);
});

test("technicians see reminders but can't change them", async ({ browser }) => {
  const origin = String(options.baseURL ?? "http://localhost:3430");
  const technician = await createStaffUser("tech", "Tess Tech", [{ garageId: hartley.id, role: "technician" }], origin);
  users.push(technician);
  const techContext = await browser.newContext(options);
  try {
    await techContext.addCookies(technician.cookies);
    const techPage = await techContext.newPage();
    await techPage.goto("/app/reminders");
    await expect(techPage.getByText("You can see these settings. Owners and managers can change them.")).toBeVisible();
    await expect(techPage.getByRole("switch", { name: "MOT due reminders" })).toBeDisabled();
    await expect(techPage.getByRole("button", { name: "Send me a test" })).toHaveCount(0);
    await expect(techPage.getByRole("link", { name: "Import customer list" })).toHaveCount(0);
    await techPage.getByRole("link", { name: "View Service due" }).click();
    const viewer = techPage.getByRole("region", { name: "Service due" });
    await expect(viewer.getByRole("textbox", { name: "Message" })).toBeDisabled();
    await expect(viewer.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expectAccessible(techPage);
  } finally {
    await techContext.close();
  }
});
