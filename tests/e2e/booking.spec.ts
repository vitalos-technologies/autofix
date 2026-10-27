/**
 * The 5-step booking flow on a garage host (P2.8): vehicle → service → time → details → confirmed.
 * Runs under playwright.garage.config.ts against `pnpm build && pnpm start` with the demo seed
 * (`pnpm db:seed`: hartley-road with MOT on, demo-b with MOT off), the mock vehicle provider and the
 * in-memory booking engine (`BOOKING_ENGINE=fake`) until the scheduling tables land.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || "3430");
const DEMO_B_ORIGIN = `http://demo-b.localhost:${port}`;
const REGISTRATION = "AB12CDE";

/** Fails the test if any request URL (pages, data, assets) carries the registration. */
function watchUrls(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return () => {
    const leaks = urls.filter((url) => decodeURIComponent(url).toUpperCase().replace(/[^A-Z0-9]/g, "").includes(REGISTRATION));
    expect(leaks, "registration in a URL").toEqual([]);
  };
}

async function expectAccessible(page: Page) {
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

async function findCar(page: Page, registration = "ab12 cde") {
  await page.goto("/");
  await page.getByLabel("Registration").fill(registration);
  await page.getByRole("button", { name: "Find my car" }).click();
  await expect(page.getByText("Vauxhall Astra", { exact: true })).toBeVisible();
}

async function chooseService(page: Page, service: RegExp = /Diagnostics/) {
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/service$/);
  await page.getByRole("radio", { name: service }).check();
  await page.getByRole("button", { name: "Choose a time" }).click();
  await page.waitForURL(/\/time/);
}

/** Picks the first free time on the n-th open day and returns its label ("Thu 29 Oct, 09:15"). */
async function pickTime(page: Page, dayIndex = 1) {
  await page.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(dayIndex).click();
  await page.locator("button[data-start]:not([disabled])").first().click();
  const action = page.locator('button[form="time-form"]');
  const label = (await action.innerText()).trim();
  expect(label).toMatch(/^\w{3} \d{1,2} \w{3}, \d\d:\d\d$/);
  await action.click();
  await page.waitForURL(/\/details$/);
  return label;
}

async function fillDetails(page: Page, name = "Test Customer", phone = "07700 900412") {
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Mobile number").fill(phone);
}

async function newPhonePage(browser: Browser) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 } });
  return context.newPage();
}

test.describe("5-step booking flow", () => {
  test("opens on the vehicle step with one visible h1 and no iframe", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expectOneVisibleH1(page, "What are we booking in?");
    await expect(page.getByText("Step 1 of 5")).toBeVisible();
    await expect(page.getByLabel("Registration")).toHaveAttribute("autocomplete", "off");
    await expect(page.locator("iframe")).toHaveCount(0);
    await expectAccessible(page);
  });

  test("books a car end to end without the registration in any URL", async ({ page, context }) => {
    const checkUrls = watchUrls(page);

    await findCar(page);
    await expect(page.getByText("MOT due 31 Mar 2027")).toBeVisible();
    await expectAccessible(page);
    const draft = (await context.cookies()).find((cookie) => cookie.name === "af_booking");
    expect(draft).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(draft?.value).not.toMatch(/AB12/i);

    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/service$/);
    await expectOneVisibleH1(page, "What does it need?");
    await expect(page.getByText("Vauxhall Astra · AB12 CDE")).toBeVisible();
    await page.getByRole("radio", { name: /Diagnostics/ }).check();
    await page.getByRole("button", { name: "Warning light" }).click();
    await expect(page.getByRole("button", { name: "Warning light" })).toHaveAttribute("aria-pressed", "true");
    await expectAccessible(page);
    await page.getByRole("button", { name: "Choose a time" }).click();

    await page.waitForURL(/\/time/);
    await expectOneVisibleH1(page, "Pick a time");
    await expect(page.getByText("Live from the diary")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose a time" })).toBeDisabled();
    await page.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(1).click();
    await expect(page).toHaveURL(/\/time\?date=\d{4}-\d{2}-\d{2}$/);
    await page.locator("button[data-start]:not([disabled])").first().click();
    await expect(page.getByText(/^Drop off at \d\d:\d\d\. Expected ready around \d\d:\d\d\./)).toBeVisible();
    await expectAccessible(page);
    const when = (await page.locator('button[form="time-form"]').innerText()).trim();
    await page.locator('button[form="time-form"]').click();

    await page.waitForURL(/\/details$/);
    await expectOneVisibleH1(page, "Who's dropping it off?");
    await expect(page.getByText("Diagnostics · Workshop")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Remind me when the MOT and service are due/ })).not.toBeChecked();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByText("Enter your full name.")).toBeVisible();
    await expect(page.getByLabel("Full name")).toBeFocused();
    await fillDetails(page);
    await page.getByRole("button", { name: "WhatsApp" }).click();
    await expectAccessible(page);
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await page.waitForURL(/\/confirmed\/[A-Z]+-\d{4,6}$/);
    await expectOneVisibleH1(page, "You're booked in");
    const reference = page.url().split("/").pop()!;
    await expect(page.getByText(reference, { exact: true })).toBeVisible();
    await expect(page.getByText(when, { exact: true })).toBeVisible();
    await expect(page.getByText("Vauxhall Astra · AB12 CDE")).toBeVisible();
    await expect(page.getByText(/We'll send your confirmation on WhatsApp to 07••• •••412/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Change or cancel" })).toHaveAttribute("href", "/manage-booking");
    await expectAccessible(page);
    expect((await context.cookies()).find((cookie) => cookie.name === "af_booking")).toBeUndefined();
    checkUrls();

    // The reference alone shows nothing: another browser gets the "find your booking" page.
    const other = await newPhonePage(page.context().browser()!);
    await other.goto(`/confirmed/${reference}`);
    await expectOneVisibleH1(other, "Find your booking");
    await expect(other.getByText(/AB12|Astra/)).toHaveCount(0);
    await other.context().close();
  });

  test("sends a customer who skips ahead back to the first incomplete step", async ({ page }) => {
    await page.goto("/details");
    await expect(page).toHaveURL(/\/$/);
    await findCar(page);
    await page.goto("/time");
    await expect(page).toHaveURL(/\/service$/);
  });

  test("continues with a car entered by hand", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Registration").fill("cd34 efg");
    await page.getByRole("button", { name: "Enter details manually" }).click();
    await expect(page.getByLabel("Make")).toBeFocused();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter the make, for example Ford.")).toBeVisible();
    await page.getByLabel("Make").fill("Ford");
    await page.getByLabel("Model").fill("Focus");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/service$/);
    await expect(page.getByText("Ford Focus · CD34 EFG")).toBeVisible();
  });

  test("forgets the car on Not your car?", async ({ page }) => {
    await findCar(page);
    await page.getByRole("button", { name: "Not your car?" }).click();
    await expect(page.getByLabel("Registration")).toHaveValue("");
    await expect(page.getByLabel("Registration")).toBeFocused();
    await expect(page.getByText("Vauxhall Astra", { exact: true })).toHaveCount(0);
  });

  test("asks for a postcode in the service area for a mobile visit", async ({ page }) => {
    await findCar(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/service$/);
    await page.getByRole("radio", { name: /Diagnostics/ }).check();
    await page.getByRole("button", { name: "Mobile visit" }).click();
    await page.getByRole("button", { name: "Choose a time" }).click();
    await expect(page.getByText(/Enter the postcode where the car will be/)).toBeVisible();
    await page.getByLabel("Postcode for the visit").fill("S6 1AA");
    await page.getByRole("button", { name: "Choose a time" }).click();
    await expect(page.getByText(/don't cover S6/)).toBeVisible();
    await page.getByLabel("Postcode for the visit").fill("dn1 1aa");
    await page.getByRole("button", { name: "Choose a time" }).click();
    await page.waitForURL(/\/time/);
    await expect(page.getByText("Diagnostics · 1 hr · Mobile visit")).toBeVisible();
  });

  test("offers the nearest free times when someone else takes the slot first", async ({ page, browser }) => {
    await findCar(page);
    await chooseService(page);
    const when = await pickTime(page, 3);
    await fillDetails(page);

    const rival = await newPhonePage(browser);
    await findCar(rival, "ef56 ghj");
    await chooseService(rival);
    expect(await pickTime(rival, 3)).toBe(when);
    await fillDetails(rival, "Rival Customer", "07700 900999");
    await rival.getByRole("button", { name: "Confirm booking" }).click();
    await rival.waitForURL(/\/confirmed\//);
    await rival.context().close();

    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForURL(/\/time\?date=\d{4}-\d{2}-\d{2}$/);
    // Filtered: Next.js has its own (empty) route announcer with role="alert".
    const alert = page.getByRole("alert").filter({ hasText: "has just been booked" });
    await expect(alert).toContainText(`Sorry, ${when} has just been booked by someone else.`);
    await expectAccessible(page);
    await alert.getByRole("button").first().click();
    await page.locator('button[form="time-form"]').click();
    await page.waitForURL(/\/details$/);
    await fillDetails(page);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForURL(/\/confirmed\//);
    await expectOneVisibleH1(page, "You're booked in");
  });

  test("hides MOT for a garage that has it switched off", async ({ page }) => {
    await page.goto(`${DEMO_B_ORIGIN}/`);
    await page.getByLabel("Registration").fill("AB12CDE");
    await page.getByRole("button", { name: "Find my car" }).click();
    await expect(page.getByText("Vauxhall Astra", { exact: true })).toBeVisible();
    await expect(page.getByText(/MOT due/)).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/service$/);
    await expect(page.getByRole("radio", { name: /Diagnostics/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^MOT/ })).toHaveCount(0);
  });

  test("has no horizontal overflow at any step on a phone", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Mobile-project coverage");
    await findCar(page);
    await noHorizontalOverflow(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/service$/);
    await noHorizontalOverflow(page);
    await page.getByRole("radio", { name: /Diagnostics/ }).check();
    await page.getByRole("button", { name: "Choose a time" }).click();
    await page.waitForURL(/\/time/);
    await noHorizontalOverflow(page);
    await pickTime(page, 2);
    await noHorizontalOverflow(page);
    await fillDetails(page);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForURL(/\/confirmed\//);
    await noHorizontalOverflow(page);
  });
});
