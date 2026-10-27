/**
 * Gate 2 (P2.8, P2.11): the 5-step booking flow on a garage host, vehicle → service → time → details → confirmed,
 * on the real booking engine (`BOOKING_ENGINE=supabase`: `available_slots()` / `create_booking()` in local Supabase).
 * Runs under playwright.garage.config.ts against `pnpm build && pnpm start` with the demo seed (`pnpm db:seed`:
 * hartley-road with MOT on and 3 bays, demo-b with MOT off) and the mock vehicle provider, on desktop, Pixel 5 and
 * an explicit 390×844 phone.
 *
 * Every test fails if any request or navigation URL in any of its browser contexts carries a registration, and axe
 * must report no violations on each of the 5 steps and on the "slot taken" state. Bookings are read back through the
 * service role to prove they are real rows. The spec uses its own customer numbers (07700 9004xx), works with
 * whatever the diary already holds (it always takes the first free time) and deletes the bookings it made, so
 * repeated runs do not depend on each other.
 */
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createLocalClient, getLocalSupabaseConfig } from "../helpers/local-supabase";

const port = Number(process.env.PLAYWRIGHT_PORT || "3430");
const DEMO_B_ORIGIN = `http://demo-b.localhost:${port}`;
const REGISTRATION = "AB12CDE";
const RIVAL_REGISTRATION = "EF56GHJ";
const MANUAL_REGISTRATION = "CD34EFG";
const REGISTRATIONS = [REGISTRATION, RIVAL_REGISTRATION, MANUAL_REGISTRATION];
/** Ofcom drama-range mobiles used only by this spec (the seed uses 9001xx and 9002xx). */
const CUSTOMER_PHONE = "07700 900461";
const RIVAL_PHONE = "07700 900462";
const SPEC_PHONES = ["+447700900461", "+447700900462", "+447700900463"];
/** Cars of the phone bookings that fill bays in the "slot taken" test. */
const FILL_REGISTRATION_PREFIX = "PW46F";

const db = createLocalClient(getLocalSupabaseConfig().secretKey);

// ---------------------------------------------------------------------------
// Checked for every context a test opens, from first request to the end of the test:
//   - no registration in any request or navigation URL;
//   - the document never loses its <title> once it has one (a streamed title used to vanish for a moment
//     after a server action, and axe's document-title rule caught it on slow CI runners).
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __bookingSpecTitleGap?: (path: string) => void;
  }
}

class PageGuard {
  private readonly urls = new Set<string>();
  readonly titleGaps: string[] = [];

  async watch(context: BrowserContext) {
    context.on("request", (request) => this.urls.add(request.url()));
    context.on("page", (page) => page.on("framenavigated", (frame) => this.urls.add(frame.url())));
    for (const page of context.pages()) page.on("framenavigated", (frame) => this.urls.add(frame.url()));

    await context.exposeFunction("__bookingSpecTitleGap", (path: string) => this.titleGaps.push(path));
    await context.addInitScript(() => {
      let hadTitle = false;
      const check = () => {
        if (document.querySelector("title")?.textContent?.trim()) hadTitle = true;
        else if (hadTitle) void window.__bookingSpecTitleGap?.(location.pathname);
      };
      new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
    });
  }

  leaks() {
    return [...this.urls].filter((url) => {
      let decoded = url;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        // Keep the raw URL.
      }
      const compact = decoded.toUpperCase().replace(/[^A-Z0-9]/g, "");
      return REGISTRATIONS.some((registration) => compact.includes(registration));
    });
  }
}

/**
 * Each browser context is a different customer, so it gets its own client address (documentation ranges, one per
 * project) instead of the whole suite sharing one: the booking pages rate-limit lookups and bookings per IP.
 */
const CLIENT_NETWORKS = ["192.0.2", "198.51.100", "203.0.113"];
let clientNumber = 0;
function nextClientIp() {
  const info = test.info();
  const projectIndex = Math.max(0, info.config.projects.findIndex((project) => project.name === info.project.name));
  clientNumber = (clientNumber % 250) + 1;
  return `${CLIENT_NETWORKS[projectIndex % CLIENT_NETWORKS.length]}.${clientNumber}`;
}

const test = base.extend<{ guard: PageGuard }>({
  guard: [
    async ({ context }, use) => {
      const guard = new PageGuard();
      await context.setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
      await guard.watch(context);
      await use(guard);
      expect(guard.leaks(), "registration in a URL").toEqual([]);
      expect(guard.titleGaps, "document without a <title> after it had one").toEqual([]);
    },
    { auto: true },
  ],
});

// ---------------------------------------------------------------------------
// Database (service role): the seeded garage and the rows this spec creates.
// ---------------------------------------------------------------------------

type Garage = { id: string; timezone: string };
let garage: Garage;
let diagnosticsId: string;
const createdReferences = new Set<string>();
const createdBookingIds = new Set<string>();

/** Bookings this spec made: the ones it noted, and leftovers of an interrupted run (its phones and cars only). */
async function deleteSpecBookings() {
  const [customers, cars, filledCars] = await Promise.all([
    db.from("customers").select("id").eq("garage_id", garage.id).in("phone", SPEC_PHONES),
    db.from("vehicles").select("id").eq("garage_id", garage.id).in("registration", [REGISTRATION, RIVAL_REGISTRATION]),
    db.from("vehicles").select("id").eq("garage_id", garage.id).like("registration", `${FILL_REGISTRATION_PREFIX}%`),
  ]);
  const lookupError = customers.error ?? cars.error ?? filledCars.error;
  if (lookupError) throw new Error(`Could not read this spec's customers and cars: ${lookupError.message}`);
  const customerIds = (customers.data ?? []).map((row) => row.id as string);
  const vehicleIds = [...(cars.data ?? []), ...(filledCars.data ?? [])].map((row) => row.id as string);
  if (customerIds.length && vehicleIds.length) {
    const { error } = await db.from("bookings").delete().eq("garage_id", garage.id).in("customer_id", customerIds).in("vehicle_id", vehicleIds);
    if (error) throw new Error(`Could not delete this spec's bookings: ${error.message}`);
  }
  if (createdReferences.size) {
    const { error } = await db.from("bookings").delete().eq("garage_id", garage.id).in("reference", [...createdReferences]);
    if (error) throw new Error(`Could not delete bookings by reference: ${error.message}`);
  }
  if (createdBookingIds.size) {
    const { error } = await db.from("bookings").delete().eq("garage_id", garage.id).in("id", [...createdBookingIds]);
    if (error) throw new Error(`Could not delete bookings by id: ${error.message}`);
  }
  createdReferences.clear();
  createdBookingIds.clear();
}

test.beforeAll(async () => {
  const found = await db.from("garages").select("id,timezone").eq("slug", "hartley-road").single();
  if (found.error || !found.data) throw new Error(`hartley-road is not seeded (pnpm db:seed): ${found.error?.message}`);
  garage = found.data as Garage;
  const service = await db.from("services").select("id").eq("garage_id", garage.id).eq("name", "Diagnostics").is("deleted_at", null).single();
  if (service.error || !service.data) throw new Error(`hartley-road has no Diagnostics service: ${service.error?.message}`);
  diagnosticsId = service.data.id as string;
  // Leftovers of an interrupted run.
  await deleteSpecBookings();
});

test.afterAll(async () => {
  await deleteSpecBookings();
});

function localDate(iso: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: garage.timezone }).format(new Date(iso));
}

async function freeCountAt(startsAt: string) {
  const day = localDate(startsAt);
  const { data, error } = await db.rpc("available_slots", { p_garage_id: garage.id, p_service_id: diagnosticsId, p_from: day, p_to: day });
  if (error) throw new Error(`available_slots failed: ${error.message}`);
  return (data as { starts_at: string; free_count: number }[]).find((slot) => Date.parse(slot.starts_at) === Date.parse(startsAt))?.free_count ?? 0;
}

/** A phone booking straight through `create_booking()`, as another customer would make. */
async function bookDirectly(startsAt: string, number: number) {
  const { data, error } = await db.rpc("create_booking", {
    p_garage_id: garage.id,
    p_booking: {
      service_id: diagnosticsId,
      starts_at: startsAt,
      location_mode: "workshop",
      source: "phone",
      idempotency_key: randomUUID(),
      customer: { name: `Phone Customer ${number}`, phone: "+447700900463", channel: "sms", reminder_consent: false },
      vehicle: { registration: `${FILL_REGISTRATION_PREFIX}${number}`, make: "Ford", model: "Focus" },
    },
  });
  if (error) throw new Error(`create_booking failed: ${error.message}`);
  createdBookingIds.add((data as { booking_id: string }).booking_id);
}

/** The booking behind a confirmation page, with its customer and vehicle. */
async function storedBooking(reference: string) {
  const booking = await db
    .from("bookings")
    .select("status,source,location_mode,symptoms,starts_at,manage_token_hash,customer_id,vehicle_id,service_id")
    .eq("garage_id", garage.id)
    .eq("reference", reference)
    .single();
  if (booking.error || !booking.data) throw new Error(`No booking ${reference}: ${booking.error?.message}`);
  const [customer, vehicle] = await Promise.all([
    db.from("customers").select("phone,channel,reminder_consent").eq("id", booking.data.customer_id).single(),
    db.from("vehicles").select("registration,make,model").eq("id", booking.data.vehicle_id).single(),
  ]);
  return { ...booking.data, customer: customer.data, vehicle: vehicle.data };
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function expectAccessible(page: Page) {
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

/** Picks the first free time on the n-th open day: its label ("Thu 29 Oct, 09:15") and instant. */
async function pickTime(page: Page, dayIndex = 1) {
  await page.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(dayIndex).click();
  const slot = page.locator("button[data-start]:not([disabled])").first();
  const startsAt = (await slot.getAttribute("data-start"))!;
  await slot.click();
  const action = page.locator('button[form="time-form"]');
  const label = (await action.innerText()).trim();
  expect(label).toMatch(/^\w{3} \d{1,2} \w{3}, \d\d:\d\d$/);
  await action.click();
  await page.waitForURL(/\/details$/);
  return { label, startsAt };
}

async function fillDetails(page: Page, name = "Test Customer", phone = CUSTOMER_PHONE) {
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Mobile number").fill(phone);
}

/** Waits for the confirmation page and remembers the booking for clean-up. */
async function confirmed(page: Page) {
  await page.waitForURL(/\/confirmed\/[A-Z]+-\d{4,6}$/);
  const reference = page.url().split("/").pop()!;
  createdReferences.add(reference);
  return reference;
}

async function newPhonePage(browser: Browser, guard: PageGuard) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-forwarded-for": nextClientIp() },
  });
  await guard.watch(context);
  return context.newPage();
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

test.describe("5-step booking flow", () => {
  test("opens on the vehicle step with one visible h1, a title and no iframe", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    // The title is in the <head> of the first HTML, not streamed into <body> later (next.config.ts htmlLimitedBots).
    const html = await response!.text();
    expect(html.slice(0, html.indexOf("</head>"))).toMatch(/<title>[^<]+<\/title>/);
    await expectOneVisibleH1(page, "What are we booking in?");
    await expect(page.getByText("Step 1 of 5")).toBeVisible();
    await expect(page.getByLabel("Registration")).toHaveAttribute("autocomplete", "off");
    await expect(page.locator("iframe")).toHaveCount(0);
    await expectAccessible(page);
  });

  test("books a car end to end on the real engine without the registration in any URL", async ({ page, context, guard }) => {
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
    const slot = page.locator("button[data-start]:not([disabled])").first();
    const startsAt = (await slot.getAttribute("data-start"))!;
    await slot.click();
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

    const reference = await confirmed(page);
    await expectOneVisibleH1(page, "You're booked in");
    await expect(page.getByText(reference, { exact: true })).toBeVisible();
    await expect(page.getByText(when, { exact: true })).toBeVisible();
    await expect(page.getByText("Vauxhall Astra · AB12 CDE")).toBeVisible();
    await expect(page.getByText(/We'll send your confirmation on WhatsApp to 07••• •••461/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Change or cancel" })).toHaveAttribute("href", "/manage-booking");
    await expectAccessible(page);
    expect((await context.cookies()).find((cookie) => cookie.name === "af_booking")).toBeUndefined();

    // A real row in the garage's diary, written by create_booking().
    const stored = await storedBooking(reference);
    expect(stored).toMatchObject({
      status: "confirmed",
      source: "online",
      location_mode: "workshop",
      symptoms: ["Warning light"],
      service_id: diagnosticsId,
      customer: { phone: "+447700900461", channel: "whatsapp", reminder_consent: false },
      vehicle: { registration: REGISTRATION, make: "Vauxhall", model: "Astra" },
    });
    expect(Date.parse(stored.starts_at)).toBe(Date.parse(startsAt));
    expect(stored.manage_token_hash).toMatch(/^[0-9a-f]{64}$/);

    // The reference alone shows nothing: another browser gets the "find your booking" page.
    const other = await newPhonePage(page.context().browser()!, guard);
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

  test("offers the nearest free times when someone else takes the slot first", async ({ page, browser, guard }) => {
    await findCar(page);
    await chooseService(page);
    const { label: when, startsAt } = await pickTime(page, 3);
    await fillDetails(page);

    // While this customer types, the garage takes phone bookings for every bay at that time but one ...
    const free = await freeCountAt(startsAt);
    expect(free, `free bays at ${when}`).toBeGreaterThan(0);
    for (let number = 1; number < free; number += 1) await bookDirectly(startsAt, number);
    expect(await freeCountAt(startsAt)).toBe(1);

    // ... and a rival customer books the last one through the booking pages.
    const rival = await newPhonePage(browser, guard);
    await findCar(rival, "ef56 ghj");
    await chooseService(rival);
    expect((await pickTime(rival, 3)).label).toBe(when);
    await fillDetails(rival, "Rival Customer", RIVAL_PHONE);
    await rival.getByRole("button", { name: "Confirm booking" }).click();
    await confirmed(rival);
    await rival.context().close();
    expect(await freeCountAt(startsAt)).toBe(0);

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
    const reference = await confirmed(page);
    await expectOneVisibleH1(page, "You're booked in");
    expect(Date.parse((await storedBooking(reference)).starts_at)).not.toBe(Date.parse(startsAt));
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

  test("has no horizontal overflow at any step", async ({ page }) => {
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
    await confirmed(page);
    await noHorizontalOverflow(page);
  });
});
