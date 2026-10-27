/**
 * Gate 3 (P3.12): a reminder link produces a booking credited to that reminder, end to end, through the real app.
 * Runs under playwright.garage.config.ts (project `gate3`, `pnpm test:e2e:gate3`) against the production build,
 * local Supabase and the database engine.
 *
 * The spec makes its own garage (MOT on, `seed_garage_defaults()`), an owner with a verified TOTP factor and one
 * customer with reminder consent whose car's MOT runs out in 5 days, and deletes all of it afterwards (the garage
 * cascades to its customers, cars, bookings, reminders, messages and jobs). In order:
 *   1. scheduled: a `reminders.schedule` job for the garage, drained by the server itself through
 *      `POST /api/jobs/drain` (Bearer CRON_SECRET), creates the 7-day MOT reminder;
 *   2. sent: a `reminders.send` job drained by the same runner (`drainJobs()`, src/lib/jobs/runner.ts) in this
 *      process, on the mock SMS channel, with its clock pinned to the latest minute of the send window
 *      (09:00-19:00 Mon-Sat, London) at or before now, so the run does not depend on the hour it starts (DECISIONS A186);
 *   3. the link is read from the mock outbox and must be the one in the `messages` row and `reminder_sends.body`;
 *   4. the link opens on the garage host (`http://<slug>.localhost:<port>/r/<token>`): a 303 to /time with the
 *      car and the MOT filled in, and the token gone from the address;
 *   5. the customer goes through all five steps (back to the service and the car, then time, details, confirmed);
 *   6. the booking has `source = 'reminder'` and `reminder_send_id`, and `reminder_sends.booking_id` is the booking;
 *   7. the owner, signed in with password + TOTP before the booking, sees Today's "Won back by reminders" go up
 *      by the booking's price.
 * axe runs with every rule at 390 and 1440 on every page visited, and neither the registration nor (after the
 * link itself) the token may appear in any request or navigation URL.
 */
import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, nextCode, type TotpMember } from "../helpers/admin-session";
import { importAppModule } from "../helpers/app-modules";
import { randomRegistration } from "../helpers/booking-fixtures";
import { enqueueTestJob, jobStatus, PLAYWRIGHT_CRON_SECRET } from "../helpers/jobs";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, localTestPassword, type LocalTestGarage } from "../helpers/local-supabase";

type Runner = typeof import("../../src/lib/jobs/runner");
type MockOutbox = typeof import("../../src/lib/messaging/mock");
type QuietHours = typeof import("../../src/lib/messaging/quiet-hours");
type TodayShape = typeof import("../../src/lib/admin/today");

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const TIME_ZONE = "Europe/London";
/** Ofcom drama-range mobile, in this spec's own garage only. */
const CUSTOMER = { name: "Rita Reminder", phone: "+447700900477", typed: "07700 900477" };
const REGISTRATION = randomRegistration();

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let siteOrigin: string;
let owner: TotpMember;
let customerId: string;
let vehicleId: string;
let motExpiry: string;
let mot: { id: string; price_pence: number };
let admin: BrowserContext;
let staffPage: Page;
let customer: BrowserContext;
let site: Page;
const urls: string[] = [];

/** Filled in as the journey goes. */
let sendId: string;
let link: string;
let token: string;
let reference: string;
let wonBackBefore: { value: string; pence: number };

function londonDate(offsetDays: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** 10:00 London time on a date, as an instant (`schedule_reminders()` sends at 10:00 garage time). */
function londonTen(date: string) {
  for (const offset of ["+00:00", "+01:00"]) {
    const candidate = new Date(`${date}T10:00:00${offset}`);
    if (new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(candidate) === "10:00") return candidate;
  }
  throw new Error(`No 10:00 in London on ${date}`);
}

function compact(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the raw URL.
  }
  return decoded.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function watch(context: BrowserContext) {
  context.on("request", (request) => urls.push(request.url()));
  context.on("page", (page) => page.on("framenavigated", (frame) => urls.push(frame.url())));
}

/** Every rule, at 390 and 1440: one <main>, no violations, no horizontal scroll. Then back to the page's own size. */
async function expectAccessibleAt(target: Page) {
  const path = new URL(target.url()).pathname;
  const own = target.viewportSize();
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    await expect(target.locator("main")).toHaveCount(1);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px on ${path}`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px on ${path}` }).toBeLessThanOrEqual(1);
  }
  if (own) await target.setViewportSize(own);
}

async function expectOneVisibleH1(target: Page, name: string | RegExp) {
  await expect(target.locator("h1:visible")).toHaveCount(1);
  await expect(target.getByRole("heading", { level: 1, name, exact: typeof name === "string" })).toBeVisible();
}

/** Today's "Won back by reminders" card (desktop KPI row). */
function wonBackCard(target: Page) {
  return target.getByRole("group", { name: "Today at a glance" }).locator("dl").filter({ has: target.getByRole("term").filter({ hasText: "Won back by reminders" }) });
}

async function postDrain(body: unknown, authorization?: string) {
  return admin.request.post(`${adminOrigin}/api/jobs/drain`, { headers: authorization ? { authorization } : {}, data: body });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "gt");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const motOn = await service.from("garages").update({ mot_enabled: true }).eq("id", garage.id);
  if (motOn.error) throw new Error(`Could not switch MOT on: ${motOn.error.message}`);
  const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (defaults.error) throw new Error(`Could not seed the garage: ${defaults.error.message}`);
  const motService = await service.from("services").select("id,price_pence").eq("garage_id", garage.id).eq("is_mot", true).is("deleted_at", null).single();
  if (motService.error || !motService.data) throw new Error(`No MOT service: ${motService.error?.message}`);
  mot = motService.data as { id: string; price_pence: number };

  // The 7-day MOT reminder's send day is 2 days ago (inside schedule_reminders()' 3-day catch-up even if the
  // date turns during the run); the 28-day one is long past, so exactly one reminder is scheduled.
  motExpiry = londonDate(5);
  const created = await service
    .from("customers")
    .insert({ garage_id: garage.id, name: CUSTOMER.name, phone: CUSTOMER.phone, preferred_contact: "phone", channel: "sms", reminder_consent: true, consent_at: new Date().toISOString(), consent_source: "import" })
    .select("id")
    .single();
  if (created.error || !created.data) throw new Error(`Could not add the customer: ${created.error?.message}`);
  customerId = created.data.id as string;
  const car = await service
    .from("vehicles")
    .insert({ garage_id: garage.id, customer_id: customerId, registration: REGISTRATION, make: "Toyota", model: "Yaris", mot_expiry: motExpiry })
    .select("id")
    .single();
  if (car.error || !car.data) throw new Error(`Could not add the car: ${car.error?.message}`);
  vehicleId = car.data.id as string;

  owner = await createTotpMember(service, garage.id, "owner", "gate3-owner");
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  staffPage = await admin.newPage();
  // A documentation-range address of its own: the booking pages rate-limit per IP.
  customer = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.177" } });
  watch(admin);
  watch(customer);
  site = await customer.newPage();
});

test.afterAll(async () => {
  await admin?.close();
  await customer?.close();
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  if (owner) await service.auth.admin.deleteUser(owner.id);
  const mock = await importAppModule<MockOutbox>("src/lib/messaging/mock.ts");
  mock.clearMockOutbox();
});

test("the owner signs in with TOTP and Today shows nothing won back yet", async () => {
  test.setTimeout(120_000);
  // The same screens as signInWithTotp(), with axe on each.
  await staffPage.goto(`${adminOrigin}/app/login`);
  await expectOneVisibleH1(staffPage, /sign in/i);
  await expectAccessibleAt(staffPage);
  await staffPage.getByLabel("Email").fill(owner.email);
  await staffPage.getByLabel("Password").fill(localTestPassword);
  await staffPage.getByRole("button", { name: "Sign in" }).click();
  await expect(staffPage).toHaveURL(/\/app\/mfa(?:\?.*)?$/);
  await expectAccessibleAt(staffPage);
  await staffPage.getByLabel("Verification code").fill(await nextCode(owner));
  await staffPage.getByRole("button", { name: "Verify" }).click();
  await expect(staffPage).toHaveURL(/\/app\/?$/);

  const card = wonBackCard(staffPage);
  await expect(card.locator("dd").first()).toHaveText("£0");
  await expect(card).toContainText("No reminder bookings this month yet");
  wonBackBefore = { value: "£0", pence: 0 };
  await expectAccessibleAt(staffPage);
});

test("scheduled: the server drains reminders.schedule through POST /api/jobs/drain", async () => {
  expect((await postDrain({ kinds: ["reminders.schedule"] })).status(), "no secret").toBe(401);
  expect((await postDrain({ kinds: ["reminders.schedule"] }, "Bearer not-the-cron-secret")).status(), "wrong secret").toBe(401);

  const job = await enqueueTestJob(service, "reminders.schedule", { garageId: garage.id }, { garageId: garage.id, dedupeKey: `gate3:reminders.schedule:${garage.id}` });
  const response = await postDrain({ kinds: ["reminders.schedule"], budgetMs: 10_000 }, `Bearer ${PLAYWRIGHT_CRON_SECRET}`);
  expect(response.status()).toBe(200);
  const { drain } = (await response.json()) as { drain: { ok: boolean; byKind: Record<string, { done: number; failed: number }> } };
  expect(drain.ok).toBe(true);
  expect(drain.byKind["reminders.schedule"]?.done ?? 0).toBeGreaterThanOrEqual(1);
  expect(await jobStatus(service, job.id)).toMatchObject({ status: "done", last_error: null });

  const { data: sends, error } = await service.from("reminder_sends").select("id,kind,offset_days,due_date,status,customer_id,vehicle_id,send_at").eq("garage_id", garage.id);
  expect(error).toBeNull();
  expect(sends).toHaveLength(1);
  expect(sends![0]).toMatchObject({ kind: "mot", offset_days: 7, due_date: motExpiry, status: "scheduled", customer_id: customerId, vehicle_id: vehicleId });
  expect(Date.parse(sends![0]!.send_at as string)).toBe(londonTen(addDays(motExpiry, -7)).getTime());
  sendId = sends![0]!.id as string;
});

test("sent: the job runner drains reminders.send on the mock SMS channel with a /r/ link", async () => {
  test.setTimeout(60_000);
  const [runner, mock, quiet] = await Promise.all([
    importAppModule<Runner>("src/lib/jobs/runner.ts"),
    importAppModule<MockOutbox>("src/lib/messaging/mock.ts"),
    importAppModule<QuietHours>("src/lib/messaging/quiet-hours.ts"),
  ]);
  // The latest minute inside the send window at or before now, by the app's own rule (A186).
  let sendNow = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  while (!quiet.isWithinSendWindow(sendNow, TIME_ZONE)) sendNow = new Date(sendNow.getTime() - 60_000);
  expect(Date.now() - sendNow.getTime(), "the window was open within the last two days").toBeLessThan(48 * 3_600_000);

  mock.clearMockOutbox();
  const job = await enqueueTestJob(service, "reminders.send", { garageId: garage.id }, { garageId: garage.id, dedupeKey: `gate3:reminders.send:${garage.id}` });
  const drain = await runner.drainJobs({
    db: service,
    kinds: ["reminders.send"],
    budgetMs: 20_000,
    now: () => sendNow,
    // Mock channels only; links on the local garage host, as the server builds them outside production.
    env: { ...process.env, MESSAGING_MODE: "mock", NODE_ENV: "test", DEV_TENANT_ROOT_DOMAIN: `localhost:${port}` },
  });
  expect(drain).toMatchObject({ ok: true, failed: 0 });
  expect(drain.byKind["reminders.send"]?.done ?? 0).toBeGreaterThanOrEqual(1);
  expect(await jobStatus(service, job.id)).toMatchObject({ status: "done", last_error: null });

  const outbox = mock.getMockOutbox().filter((entry) => entry.garageId === garage.id);
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({ kind: "sms", to: CUSTOMER.phone, idempotencyKey: `reminder_send:${sendId}` });
  const sms = outbox[0]!;
  // The one-text default wording (A184) with a 22-character link token (A185).
  expect(sms.body).toMatch(/^.+: Hi Rita, MOT due \d{1,2} [A-Z][a-z]{2}\. Book: \S+\nReply STOP to opt out\.$/);
  const found = new RegExp(`Book: (http://${garage.slug.replace(/[-.]/g, "\\$&")}\\.localhost:${port}/r/([A-Za-z0-9_-]{22}))\\n`).exec(sms.body);
  expect(found, `the link in "${sms.body}"`).not.toBeNull();
  [, link, token] = found as unknown as [string, string, string];

  const { data: send } = await service.from("reminder_sends").select("status,provider_msg_id,link_token_hash,link_expires_at,sent_at,body,booking_id").eq("id", sendId).single();
  expect(send).toMatchObject({ status: "sent", provider_msg_id: sms.providerMessageId, body: sms.body, booking_id: null });
  expect(send?.link_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  expect(Date.parse(send!.sent_at as string)).toBe(sendNow.getTime());
  expect(Date.parse(send!.link_expires_at as string)).toBeGreaterThan(Date.now());
  const { data: messages } = await service.from("messages").select("direction,channel,status,to_address,provider,provider_msg_id,reminder_send_id,customer_id,body").eq("garage_id", garage.id);
  expect(messages).toEqual([
    { direction: "outbound", channel: "sms", status: "queued", to_address: CUSTOMER.phone, provider: "mock", provider_msg_id: sms.providerMessageId, reminder_send_id: sendId, customer_id: customerId, body: sms.body },
  ]);
});

test("the link opens the booking flow on the garage host with the car and MOT filled in, and drops the token", async () => {
  const response = await site.goto(link);
  expect(response?.status()).toBe(200);
  await expect(site).toHaveURL(`${siteOrigin}/time`);
  const first = response!.request().redirectedFrom();
  expect(first?.url()).toBe(link);
  const redirect = await first!.response();
  expect(redirect?.status()).toBe(303);
  expect(await redirect!.headerValue("location")).toBe("/time");
  expect(await redirect!.headerValue("referrer-policy")).toBe("no-referrer");
  expect(await redirect!.headerValue("cache-control")).toContain("no-store");

  const draft = (await customer.cookies()).find((cookie) => cookie.name === "af_booking");
  expect(draft).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(compact(draft!.value)).not.toContain(REGISTRATION);
  expect(draft!.value).not.toContain(token);

  await expectOneVisibleH1(site, "Pick a time");
  await expect(site.getByText(/^MOT · .+ · Workshop$/)).toBeVisible();
  await expect(site.getByText("Step 3 of 5")).toBeVisible();
  await expectAccessibleAt(site);
  const { data: opened } = await service.from("reminder_sends").select("opened_at").eq("id", sendId).single();
  expect(opened?.opened_at).toBeTruthy();
});

test("the customer goes through the five steps and books the MOT", async () => {
  test.setTimeout(90_000);
  // Step 2: the reminder's service is already chosen.
  await site.getByRole("link", { name: "Back to service" }).click();
  await site.waitForURL(`${siteOrigin}/service`);
  await expectOneVisibleH1(site, "What does it need?");
  await expect(site.getByRole("radio", { name: /^MOT/ })).toBeChecked();
  await expectAccessibleAt(site);

  // Step 1: the reminder's car; continuing with it keeps the reminder.
  await site.getByRole("link", { name: "Back to vehicle" }).click();
  await site.waitForURL(`${siteOrigin}/`);
  await expect(site.getByText("Step 1 of 5")).toBeVisible();
  await expect(site.getByText("Toyota Yaris", { exact: true })).toBeVisible();
  await expect(site.getByText(/^MOT due /)).toBeVisible();
  await expectAccessibleAt(site);
  await site.getByRole("button", { name: "Continue" }).click();
  await site.waitForURL(`${siteOrigin}/service`);
  await expect(site.getByRole("radio", { name: /^MOT/ })).toBeChecked();
  await site.getByRole("button", { name: "Choose a time" }).click();

  // Step 3: the first free time on the second open day.
  await site.waitForURL(/\/time(?:\?date=\d{4}-\d{2}-\d{2})?$/);
  await site.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(1).click();
  const slot = site.locator("button[data-start]:not([disabled])").first();
  const startsAt = (await slot.getAttribute("data-start"))!;
  await slot.click();
  await expectAccessibleAt(site);
  await site.locator('button[form="time-form"]').click();

  // Step 4: the customer's own mobile, so the booking is theirs (A52).
  await site.waitForURL(`${siteOrigin}/details`);
  await expectOneVisibleH1(site, "Who's dropping it off?");
  await expect(site.getByText("MOT · Workshop")).toBeVisible();
  await site.getByLabel("Full name").fill(CUSTOMER.name);
  await site.getByLabel("Mobile number").fill(CUSTOMER.typed);
  await expectAccessibleAt(site);
  await site.getByRole("button", { name: "Confirm booking" }).click();

  // Step 5.
  await site.waitForURL(/\/confirmed\/[A-Z]+-\d{4,6}$/);
  reference = site.url().split("/").pop()!;
  await expectOneVisibleH1(site, "You're booked in");
  await expect(site.getByText(reference, { exact: true })).toBeVisible();
  await expectAccessibleAt(site);

  const { data: booking } = await service.from("bookings").select("starts_at").eq("garage_id", garage.id).eq("reference", reference).single();
  expect(Date.parse(booking!.starts_at as string)).toBe(Date.parse(startsAt));
});

test("the booking is credited to the reminder", async () => {
  const { data: booking, error } = await service
    .from("bookings")
    .select("id,source,reminder_send_id,status,service_id,customer_id,vehicle_id,price_pence")
    .eq("garage_id", garage.id)
    .eq("reference", reference)
    .single();
  expect(error).toBeNull();
  expect(booking).toMatchObject({ source: "reminder", reminder_send_id: sendId, status: "confirmed", service_id: mot.id, customer_id: customerId, vehicle_id: vehicleId, price_pence: mot.price_pence });
  const { data: send } = await service.from("reminder_sends").select("booking_id,status").eq("id", sendId).single();
  expect(send).toEqual({ booking_id: booking!.id, status: "sent" });
  const { data: created } = await service.from("booking_events").select("actor,data").eq("booking_id", booking!.id).eq("type", "created").single();
  expect(created?.data).toMatchObject({ reminder_send_id: sendId });

  const wonBack = await service.rpc("reminder_won_back", { p_garage_id: garage.id, p_from: londonDate(0).slice(0, 8) + "01", p_to: londonDate(0) });
  expect(wonBack.error).toBeNull();
  expect(wonBack.data).toEqual([expect.objectContaining({ bookings: 1, pence: mot.price_pence })]);
});

test("Today's Won back by reminders goes up by the booking's price", async () => {
  const today = await importAppModule<TodayShape>("src/lib/admin/today.ts");
  await staffPage.goto(`${adminOrigin}/app`);
  const card = wonBackCard(staffPage);
  const expected = today.formatWholePounds(wonBackBefore.pence + mot.price_pence);
  expect(expected).not.toBe(wonBackBefore.value);
  await expect(card.locator("dd").first()).toHaveText(expected);
  await expect(card).toContainText("1 booking this month");
  const reminders = staffPage.locator("#reminders-week");
  await expect(reminders.locator("div").filter({ has: staffPage.getByRole("term").filter({ hasText: /^Booked$/ }) }).getByRole("definition")).toHaveText("1");
  await expectAccessibleAt(staffPage);

  // Neither the registration nor the token in any URL (the link itself is the one place the token goes).
  expect(urls.filter((url) => compact(url).includes(REGISTRATION)), "registration in a URL").toEqual([]);
  expect(urls.filter((url) => url.includes(token) && url !== link), "token in a URL after the link").toEqual([]);
});
