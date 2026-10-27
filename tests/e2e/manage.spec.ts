/**
 * Manage booking on a garage host (P2.9): `/manage` (reference + registration, or the signed link
 * from the confirmation email), `/manage/reschedule` and `/manage/cancel`. Runs under
 * playwright.garage.config.ts (project `manage-mobile`, 390 × 844) against the production build,
 * the demo seed (`pnpm db:seed`) and the database engine: bookings are made through the five
 * booking steps or, for the other states, as the service role through `create_booking()`.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  cancelFixtures,
  createManageFixture,
  moveInsideCutoff,
  randomRegistration,
  seededGarage,
  serviceClient,
  setStatus,
  type ManageFixture,
  type SeededGarage,
} from "../helpers/booking-fixtures";

let garage: SeededGarage;
const created: string[] = [];

test.beforeAll(async () => {
  garage = await seededGarage();
});

test.afterAll(async () => {
  await cancelFixtures(created);
});

async function fixture(options: Parameters<typeof createManageFixture>[1] = {}): Promise<ManageFixture> {
  const booking = await createManageFixture(garage, options);
  created.push(booking.id);
  return booking;
}

function compact(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Every request URL the page makes (documents, data, assets), for the privacy checks. */
function recordUrls(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

function expectNoRegistrationIn(urls: readonly string[], registration: string) {
  const leaks = urls.filter((url) => compact(decodeURIComponent(url)).includes(compact(registration)));
  expect(leaks, "registration in a URL").toEqual([]);
}

async function expectAccessible(page: Page) {
  // The document title can arrive a moment after a server action's navigation.
  await expect(page).toHaveTitle(/\S/);
  // Let colour transitions on just-pressed buttons finish so axe measures the final colours.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function expectOneVisibleH1(page: Page, name: string | RegExp) {
  await expect(page.locator("h1:visible")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function bookingCard(page: Page) {
  const card = page.getByRole("region", { name: "Booking details" });
  await expect(card).toBeVisible();
  return card;
}

/** Books a car through the five booking steps and returns the reference and the time label. */
async function bookThroughTheSteps(page: Page, registration: string) {
  await page.goto("/");
  await page.getByLabel("Registration").fill(registration);
  await page.getByRole("button", { name: "Find my car" }).click();
  await expect(page.getByText("Vauxhall Astra", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/service$/);
  await page.getByRole("radio", { name: /Diagnostics/ }).check();
  await page.getByRole("button", { name: "Choose a time" }).click();
  await page.waitForURL(/\/time/);
  // A day or two out, so the booking is beyond the garage's 24-hour cutoff.
  await page.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(2).click();
  await page.locator("button[data-start]:not([disabled])").first().click();
  const action = page.locator('button[form="time-form"]');
  const when = (await action.innerText()).trim();
  await action.click();
  await page.waitForURL(/\/details$/);
  await page.getByLabel("Full name").fill("Manage Journey");
  await page.getByLabel("Mobile number").fill("07700 900466");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await page.waitForURL(/\/confirmed\/[A-Z]+-\d{4,6}$/);
  const reference = page.url().split("/").pop()!;
  return { reference, when };
}

async function lookUp(page: Page, reference: string, registration: string) {
  await page.getByLabel("Booking reference").fill(reference);
  await page.getByLabel("Registration").fill(registration);
  await page.getByRole("button", { name: "Find my booking" }).click();
}

test.describe("manage booking", () => {
  test("finds a booking by reference and registration, moves it, then cancels it", async ({ page, context }) => {
    const urls = recordUrls(page);
    const registration = randomRegistration();
    const { reference, when } = await bookThroughTheSteps(page, registration);
    const { data: booked } = await serviceClient().from("bookings").select("id").eq("garage_id", garage.id).eq("reference", reference).single();
    if (booked) created.push(booked.id);

    // Book 5 → Change or cancel → the lookup form (no session yet on this device).
    await page.getByRole("link", { name: "Change or cancel" }).click();
    await page.waitForURL(/\/manage$/);
    await expectOneVisibleH1(page, "Find your booking");
    await expect(page.getByLabel("Booking reference")).toHaveAttribute("autocomplete", "off");
    await expect(page.getByLabel("Registration")).toHaveAttribute("autocomplete", "off");
    await expectAccessible(page);
    await noHorizontalOverflow(page);

    // A wrong registration and a reference that does not exist get the same answer.
    const alert = page.getByRole("alert").filter({ hasText: /couldn't find a booking/ });
    await lookUp(page, reference, randomRegistration());
    await expect(alert).toBeVisible();
    const wrongRegistration = (await alert.innerText()).trim();
    await expectAccessible(page);
    await lookUp(page, "ZZZ-0000", registration);
    await expect(alert).toBeVisible();
    expect((await alert.innerText()).trim()).toBe(wrongRegistration);
    expect((await context.cookies()).find((cookie) => cookie.name === "af_manage")).toBeUndefined();
    await expect(page).toHaveURL(/\/manage$/);

    // The right details open the booking.
    await lookUp(page, reference.toLowerCase(), registration.toLowerCase());
    await expectOneVisibleH1(page, "Your booking");
    await expect(page).toHaveURL(/\/manage$/);
    const session = (await context.cookies()).find((cookie) => cookie.name === "af_manage");
    expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(compact(session!.value)).not.toContain(compact(registration));
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
    const card = await bookingCard(page);
    await expect(card.getByText(reference, { exact: true })).toBeVisible();
    await expect(card.getByText(when, { exact: true })).toBeVisible();
    await expect(card.getByText("Diagnostics", { exact: true })).toBeVisible();
    await expect(card.getByText("Vauxhall Astra", { exact: true })).toBeVisible();
    await expect(card.getByText("Manage Journey", { exact: true })).toBeVisible();
    await expect(card.getByText("07••• •••466")).toBeVisible();
    await expect(card.getByText("07700 900466")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Add to calendar" })).toHaveAttribute("href", new RegExp(`^/api/bookings/calendar/${reference}\\?signature=`));
    await expectAccessible(page);
    await noHorizontalOverflow(page);

    // Move it to another day.
    await page.getByRole("link", { name: "Change the time" }).click();
    await page.waitForURL(/\/manage\/reschedule$/);
    await expectOneVisibleH1(page, "Pick a new time");
    await expect(page.getByText(`Booked now for ${when}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose a new time" })).toBeDisabled();
    await expectAccessible(page);
    await noHorizontalOverflow(page);
    const days = page.getByRole("group", { name: "Choose a day" }).locator('button:not([disabled]):not([aria-pressed="true"])');
    await days.last().click();
    await expect(page).toHaveURL(/\/manage\/reschedule\?date=\d{4}-\d{2}-\d{2}$/);
    await page.locator("button[data-start]:not([disabled])").first().click();
    const move = page.locator('button[form="manage-reschedule-form"]');
    const moveLabel = (await move.innerText()).trim();
    expect(moveLabel).toMatch(/^Move to \w{3} \d{1,2} \w{3}, \d\d:\d\d$/);
    const newWhen = moveLabel.replace(/^Move to /, "");
    expect(newWhen).not.toBe(when);
    await expectAccessible(page);
    await move.click();

    await page.waitForURL(/\/manage\?done=moved$/);
    await expect(page.getByRole("status").filter({ hasText: "Your booking has moved" })).toContainText(newWhen);
    await expect((await bookingCard(page)).getByText(newWhen, { exact: true })).toBeVisible();
    await expectAccessible(page);

    // Then cancel it, with a reason for the garage.
    await page.getByRole("link", { name: "Cancel booking" }).click();
    await page.waitForURL(/\/manage\/cancel$/);
    await expectOneVisibleH1(page, "Cancel this booking?");
    await expect(page.getByText("Diagnostics · Workshop")).toBeVisible();
    await page.getByLabel(/Reason/).fill("Car sold");
    await expectAccessible(page);
    await noHorizontalOverflow(page);
    await page.getByRole("button", { name: "Cancel booking" }).click();

    await page.waitForURL(/\/manage\?done=cancelled$/);
    await expect(page.getByRole("status").filter({ hasText: "Your booking is cancelled" })).toBeVisible();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Change the time" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Book a car in" })).toHaveAttribute("href", "/");
    await expectAccessible(page);
    const { data: row } = await serviceClient().from("bookings").select("status,cancellation_reason").eq("garage_id", garage.id).eq("reference", reference).single();
    expect(row).toEqual({ status: "cancelled", cancellation_reason: "Car sold" });

    // Neither page can change a cancelled booking.
    await page.goto("/manage/reschedule");
    await expect(page).toHaveURL(/\/manage$/);
    await page.goto("/manage/cancel");
    await expect(page).toHaveURL(/\/manage$/);

    expectNoRegistrationIn(urls, registration);
  });

  test("opens a booking from the signed link and drops the token from the address", async ({ page, context }) => {
    const booking = await fixture({ customerName: "Link Customer" });
    const urls = recordUrls(page);

    await page.goto(`/manage?token=${booking.token}`);
    await expect(page).toHaveURL(/\/manage$/);
    await expectOneVisibleH1(page, "Your booking");
    await expect((await bookingCard(page)).getByText(booking.reference, { exact: true })).toBeVisible();
    await expect(page.getByText("Link Customer", { exact: true })).toBeVisible();
    expect((await context.cookies()).find((cookie) => cookie.name === "af_manage")).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    await expectAccessible(page);

    // Only the link itself and its hand-over carried the token; nothing after it does.
    const withToken = urls.filter((url) => url.includes(booking.token));
    expect(withToken.map((url) => new URL(url).pathname)).toEqual(["/manage", "/manage/link"]);
    expect(page.url()).not.toContain(booking.token);
    expect(await page.evaluate(() => document.referrer)).not.toContain(booking.token);
    await page.getByRole("link", { name: "Change the time" }).click();
    await page.waitForURL(/\/manage\/reschedule$/);
    await page.getByRole("link", { name: "Back to your booking" }).click();
    await page.waitForURL(/\/manage$/);
    expect(urls.filter((url) => url.includes(booking.token))).toHaveLength(2);
    expectNoRegistrationIn(urls, booking.registration);

    // "Look up another booking" closes the session on this device.
    await page.getByRole("button", { name: "Look up another booking" }).click();
    await expectOneVisibleH1(page, "Find your booking");
    expect((await context.cookies()).find((cookie) => cookie.name === "af_manage")).toBeUndefined();

    // SOB's old address still works.
    await page.goto(`/manage-booking?token=${booking.token}`);
    await expect(page).toHaveURL(/\/manage$/);
    await expect((await bookingCard(page)).getByText(booking.reference, { exact: true })).toBeVisible();
  });

  test("sends a link that does not open a booking to the lookup form", async ({ page, context }) => {
    const bogus = "A".repeat(43);
    await page.goto(`/manage?token=${bogus}`);
    await expect(page).toHaveURL(/\/manage\?link=invalid$/);
    await expectOneVisibleH1(page, "Find your booking");
    await expect(page.getByText("That link didn't open a booking")).toBeVisible();
    expect((await context.cookies()).find((cookie) => cookie.name === "af_manage")).toBeUndefined();
    await expectAccessible(page);

    await page.goto("/manage?token=not-a-token");
    await expect(page).toHaveURL(/\/manage\?link=invalid$/);
  });

  test("shows what the customer can do in every other state", async ({ page }) => {
    // Awaiting the garage's OK: still changeable online.
    const requested = await fixture({ service: "Brakes" });
    expect(requested.status).toBe("requested");
    await page.goto(`/manage?token=${requested.token}`);
    await expectOneVisibleH1(page, "Your booking");
    await expect(page.getByText("Awaiting the garage's OK", { exact: true })).toBeVisible();
    await expect(page.getByText(`${garage.name} will check the job and confirm the time with you.`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Change the time" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add to calendar" })).toHaveCount(0);
    await expectAccessible(page);

    // Inside the cancellation cutoff: call the garage instead.
    const soon = await moveInsideCutoff(await fixture());
    await page.goto(`/manage?token=${soon.token}`);
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
    await expect(page.getByText("Too close to change online")).toBeVisible();
    await expect(page.getByText(`in the last ${garage.cutoffHours} hours before they start`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Change the time" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Cancel booking" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Call 0/ })).toHaveAttribute("href", /^tel:\+44/);
    await expect(page.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\//);
    await expectAccessible(page);
    await page.goto("/manage/reschedule");
    await expect(page).toHaveURL(/\/manage$/);
    await page.goto("/manage/cancel");
    await expect(page).toHaveURL(/\/manage$/);

    // The car is with the garage.
    const arrived = await fixture();
    await setStatus(arrived, "arrived");
    await page.goto(`/manage?token=${arrived.token}`);
    await expect(page.getByText("Arrived", { exact: true })).toBeVisible();
    await expect(page.getByText(`Your car is with ${garage.name}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Change the time" })).toHaveCount(0);
    await expectAccessible(page);

    // Finished.
    const collected = await fixture();
    await setStatus(collected, "collected");
    await page.goto(`/manage?token=${collected.token}`);
    await expect(page.getByText("Collected", { exact: true })).toBeVisible();
    await expect(page.getByText("This booking is finished")).toBeVisible();
    await expect(page.getByRole("link", { name: "Book a car in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Change the time" })).toHaveCount(0);
    await expectAccessible(page);
  });

  test("fits a 1440px desktop without horizontal scroll", async ({ page }) => {
    const booking = await fixture();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/manage");
    await noHorizontalOverflow(page);
    await page.goto(`/manage?token=${booking.token}`);
    await expectOneVisibleH1(page, "Your booking");
    await noHorizontalOverflow(page);
    await page.goto("/manage/reschedule");
    await expectOneVisibleH1(page, "Pick a new time");
    await noHorizontalOverflow(page);
    await page.goto("/manage/cancel");
    await expectOneVisibleH1(page, "Cancel this booking?");
    await noHorizontalOverflow(page);
    await expectAccessible(page);
  });
});
