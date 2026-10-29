/**
 * P5.5 Campaigns (Pro feature `campaigns`), end to end through the real app. Runs under
 * playwright.garage.config.ts (project `p5-campaigns`, `pnpm test:e2e:p5-campaigns`) against the production
 * build and local Supabase.
 *
 * The spec makes its own garage (MOT on, `seed_garage_defaults()`, on the Pro trial every new garage gets), an
 * owner with a verified TOTP factor, a customer who ticked the offers box and has a 9-year-old car, and a customer
 * with reminder consent only (not enough for campaigns since consent wording v1.0); it deletes all of it
 * afterwards. In order:
 *   1. /app/campaigns: results, the ready-made starting points, the empty list;
 *   2. the "Winter check" starter: live count (1 customer: offers consent is required), a filter that matches nobody,
 *      the wording with the opt-out line, the link's service; saved as a draft;
 *   3. the draft: "Send me a test", then scheduled for tomorrow 10:00 UK time;
 *   4. the send: a `campaigns.send` job drained by the job runner in this process on the mock SMS channel, its
 *      clock pinned inside the send window (09:00-19:00 Mon-Sat), with a hashed /c/ link;
 *   5. the link opens the booking flow on the garage host with the car and service filled in, and the customer
 *      books; the booking is credited to the send (attribute_campaign_booking());
 *   6. the campaign page shows sent, opened, 1 booking and the £ won;
 *   7. moved to Essentials: the locked state (ProLockedPage) with the earlier campaign still listed, and the
 *      editor locked too.
 * axe runs with every rule at 390 and 1440 on every new screen, and screenshots of each go to
 * docs/autofix/screenshots/phase-5/campaigns-<screen>-<390|1440>.png. The registration never appears in a URL.
 */
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect as baseExpect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, nextCode, type TotpMember } from "../helpers/admin-session";
import { importAppModule } from "../helpers/app-modules";
import { randomRegistration } from "../helpers/booking-fixtures";
import { enqueueTestJob, jobStatus } from "../helpers/jobs";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, localTestPassword, type LocalTestGarage } from "../helpers/local-supabase";

type Runner = typeof import("../../src/lib/jobs/runner");
type MockOutbox = typeof import("../../src/lib/messaging/mock");
type QuietHours = typeof import("../../src/lib/messaging/quiet-hours");

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const TIME_ZONE = "Europe/London";
const SHOTS = "docs/autofix/screenshots/phase-5";
const CUSTOMER = { name: "Wendy Winter", phone: "+447700900588", typed: "07700 900588" };
const REGISTRATION = randomRegistration();
// Server actions and the live count round-trip through a production server on a shared CPU.
const expect = baseExpect.configure({ timeout: 20_000 });

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let siteOrigin: string;
let owner: TotpMember;
let customerId: string;
let vehicleId: string;
let diagnostics: { id: string; price_pence: number };
let admin: BrowserContext;
let staffPage: Page;
let customer: BrowserContext;
let site: Page;
let campaignId: string;
let sendId: string;
let link: string;
let token: string;
let reference: string;
const urls: string[] = [];

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

/** Every axe rule at 390 and 1440, no horizontal scroll; a full-page screenshot of each when `shot` is given. */
async function expectAccessibleAt(target: Page, shot?: string) {
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
    if (shot) await target.screenshot({ path: `${SHOTS}/campaigns-${shot}-${width}.png`, fullPage: true });
  }
  if (own) await target.setViewportSize(own);
}

function tomorrowAtTen() {
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(Date.now() + 86_400_000));
  return `${tomorrow}T10:00`;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  garage = await createLocalGarage(service, "cp");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const motOn = await service.from("garages").update({ mot_enabled: true }).eq("id", garage.id);
  if (motOn.error) throw new Error(`Could not switch MOT on: ${motOn.error.message}`);
  const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (defaults.error) throw new Error(`Could not seed the garage: ${defaults.error.message}`);
  const diag = await service.from("services").select("id,price_pence").eq("garage_id", garage.id).eq("name", "Diagnostics").is("deleted_at", null).single();
  if (diag.error || !diag.data) throw new Error(`No Diagnostics service: ${diag.error?.message}`);
  diagnostics = diag.data as { id: string; price_pence: number };

  const created = await service
    .from("customers")
    .insert([
      {
        garage_id: garage.id, name: CUSTOMER.name, phone: CUSTOMER.phone, preferred_contact: "phone", channel: "sms",
        reminder_consent: true, consent_at: new Date().toISOString(), consent_source: "booking",
        offers_consent: true, offers_consent_at: new Date().toISOString(), offers_consent_source: "booking",
        offers_consent_text: `Send me occasional offers from ${garage.name}. You can stop these any time.`,
      },
      // Reminder consent alone does not put a customer in a campaign.
      { garage_id: garage.id, name: "Nora Remindersonly", phone: "+447700900589", preferred_contact: "phone", channel: "sms", reminder_consent: true, consent_at: new Date().toISOString(), consent_source: "booking" },
    ])
    .select("id,name");
  if (created.error || !created.data) throw new Error(`Could not add the customers: ${created.error?.message}`);
  customerId = created.data.find((row) => row.name === CUSTOMER.name)!.id as string;
  const other = created.data.find((row) => row.name !== CUSTOMER.name)!.id as string;
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric" }).format(new Date()));
  const cars = await service
    .from("vehicles")
    .insert([
      { garage_id: garage.id, customer_id: customerId, registration: REGISTRATION, make: "Skoda", model: "Octavia", year: year - 9 },
      { garage_id: garage.id, customer_id: other, registration: randomRegistration(), make: "Kia", model: "Ceed", year: year - 9 },
    ])
    .select("id,customer_id");
  if (cars.error || !cars.data) throw new Error(`Could not add the cars: ${cars.error?.message}`);
  vehicleId = cars.data.find((row) => row.customer_id === customerId)!.id as string;

  owner = await createTotpMember(service, garage.id, "owner", "p5-campaigns-owner");
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  staffPage = await admin.newPage();
  customer = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.188" } });
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

test("the Campaigns page lists starting points and no campaigns yet", async () => {
  test.setTimeout(120_000);
  // Password + TOTP, with room for a cold production server under a shared CPU.
  await staffPage.goto(`${adminOrigin}/app/login`);
  await staffPage.getByLabel("Email").fill(owner.email);
  await staffPage.getByLabel("Password").fill(localTestPassword);
  await staffPage.getByRole("button", { name: "Sign in" }).click();
  await expect(staffPage).toHaveURL(/\/app\/mfa(?:\?.*)?$/, { timeout: 30_000 });
  await staffPage.getByLabel("Verification code").fill(await nextCode(owner));
  await staffPage.getByRole("button", { name: "Verify" }).click();
  await expect(staffPage).toHaveURL(/\/app\/?$/, { timeout: 30_000 });
  await staffPage.getByRole("link", { name: "Campaigns" }).first().click();
  await expect(staffPage).toHaveURL(`${adminOrigin}/app/campaigns`);
  await expect(staffPage.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
  await expect(staffPage.getByRole("link", { name: /Winter check/ })).toBeVisible();
  await expect(staffPage.getByRole("link", { name: /MOT month/ })).toBeVisible();
  await expect(staffPage.getByText("No campaigns yet")).toBeVisible();
  await expectAccessibleAt(staffPage, "list");
});

test("a Winter check from the starter: live count, wording and the link's service, saved as a draft", async () => {
  test.setTimeout(120_000);
  await staffPage.getByRole("link", { name: /Winter check/ }).click();
  await expect(staffPage).toHaveURL(`${adminOrigin}/app/campaigns/new?starter=winter_check`);
  await expect(staffPage.getByRole("heading", { level: 1, name: "New campaign: Winter check" })).toBeVisible();
  // Only the customer who ticked the offers box (reminder consent alone is not enough).
  await expect(staffPage.getByText("1 customer match")).toBeVisible();
  const list = staffPage.getByRole("list", { name: "First matching customers" });
  await expect(list.getByText(CUSTOMER.name)).toBeVisible();
  await expect(list.getByText("Nora Remindersonly")).toHaveCount(0);
  await expect(list.getByText("Ticked offers")).toBeVisible();
  await expect(list).not.toContainText(CUSTOMER.phone);
  await expect(staffPage.getByText(/Reply STOP to opt out\./).first()).toBeVisible();
  await expect(staffPage.getByText(/of 160 characters · 1 text/)).toBeVisible();

  // A filter nobody matches, then back.
  await staffPage.getByLabel("From").fill("20");
  await expect(staffPage.getByText("0 customers match")).toBeVisible();
  await staffPage.getByLabel("From").fill("5");
  await expect(staffPage.getByText("1 customer match")).toBeVisible();

  await staffPage.getByLabel("The link opens").selectOption({ label: "Diagnostics" });
  await expectAccessibleAt(staffPage, "new");
  await staffPage.getByRole("button", { name: "Save and continue" }).click();
  await expect(staffPage).toHaveURL(/\/app\/campaigns\/[0-9a-f-]{36}\?done=saved$/);
  campaignId = new URL(staffPage.url()).pathname.split("/").pop()!;
  await expect(staffPage.getByText("Draft saved.").first()).toBeVisible();

  const { data } = await service.from("campaigns").select("status,starter,segment,service_id,template").eq("id", campaignId).single();
  expect(data).toMatchObject({ status: "draft", starter: "winter_check", segment: { car_age_min: 5 }, service_id: diagnostics.id });
});

test("the draft: send me a test, then schedule for tomorrow 10:00 UK time", async () => {
  test.setTimeout(120_000);
  await expect(staffPage.getByRole("button", { name: "Send to 1 customer" })).toBeVisible();
  await expectAccessibleAt(staffPage, "draft");
  await staffPage.getByRole("button", { name: "Send me a test" }).click();
  await expect(staffPage.getByText(/Test made for your (email|mobile)/)).toBeVisible();

  await staffPage.getByText("Pick a time", { exact: true }).click();
  await staffPage.getByLabel(/Date and time/).fill(tomorrowAtTen());
  await staffPage.getByRole("button", { name: "Schedule" }).click();
  await expect(staffPage).toHaveURL(new RegExp(`/app/campaigns/${campaignId}\\?done=scheduled$`));
  await expect(staffPage.getByRole("cell", { name: CUSTOMER.name }).or(staffPage.getByRole("rowheader", { name: CUSTOMER.name }))).toBeVisible();

  const { data: sends } = await service.from("campaign_sends").select("id,status,customer_id,vehicle_id,send_at").eq("campaign_id", campaignId);
  expect(sends).toHaveLength(1);
  expect(sends![0]).toMatchObject({ status: "scheduled", customer_id: customerId, vehicle_id: vehicleId });
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(sends![0]!.send_at as string));
  expect(local).toBe("10:00");
  sendId = sends![0]!.id as string;
  const { data: job } = await service.from("jobs").select("kind,status").eq("garage_id", garage.id).eq("kind", "campaigns.send").single();
  expect(job).toMatchObject({ status: "queued" });
});

test("sent: campaigns.send drained inside the send window on the mock SMS channel, with a hashed /c/ link", async () => {
  test.setTimeout(60_000);
  const [runner, mock, quiet] = await Promise.all([
    importAppModule<Runner>("src/lib/jobs/runner.ts"),
    importAppModule<MockOutbox>("src/lib/messaging/mock.ts"),
    importAppModule<QuietHours>("src/lib/messaging/quiet-hours.ts"),
  ]);
  let sendNow = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  while (!quiet.isWithinSendWindow(sendNow, TIME_ZONE)) sendNow = new Date(sendNow.getTime() - 60_000);
  // Bring the scheduled time forward to just before that minute (the campaign was scheduled for tomorrow).
  const due = new Date(sendNow.getTime() - 60_000).toISOString();
  await service.from("campaign_sends").update({ send_at: due }).eq("id", sendId);
  await service.from("campaigns").update({ send_at: due }).eq("id", campaignId);

  mock.clearMockOutbox();
  const job = await enqueueTestJob(service, "campaigns.send", { garageId: garage.id }, { garageId: garage.id, dedupeKey: `p5-campaigns:send:${garage.id}` });
  const drain = await runner.drainJobs({
    db: service,
    kinds: ["campaigns.send"],
    budgetMs: 20_000,
    now: () => sendNow,
    env: { ...process.env, MESSAGING_MODE: "mock", NODE_ENV: "test", DEV_TENANT_ROOT_DOMAIN: `localhost:${port}` },
  });
  expect(drain).toMatchObject({ ok: true, failed: 0 });
  expect(await jobStatus(service, job.id)).toMatchObject({ status: "done", last_error: null });

  const outbox = mock.getMockOutbox().filter((entry) => entry.garageId === garage.id);
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({ kind: "sms", to: CUSTOMER.phone, idempotencyKey: `campaign_send:${sendId}` });
  const found = new RegExp(`(http://${garage.slug.replace(/[-.]/g, "\\$&")}\\.localhost:${port}/c/([A-Za-z0-9_-]{22}))\\nReply STOP to opt out\\.$`).exec(outbox[0]!.body);
  expect(found, `the link in "${outbox[0]!.body}"`).not.toBeNull();
  [, link, token] = found as unknown as [string, string, string];
  expect(outbox[0]!.body).toContain("Hi Wendy, book a winter check:");

  const { data: send } = await service.from("campaign_sends").select("status,link_token_hash,sent_at,message_id").eq("id", sendId).single();
  expect(send).toMatchObject({ status: "sent" });
  expect(send?.link_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  const { data: campaign } = await service.from("campaigns").select("status").eq("id", campaignId).single();
  expect(campaign?.status).toBe("sent");
});

test("the link opens the booking flow with the car and service, and the booking counts for the campaign", async () => {
  test.setTimeout(120_000);
  const response = await site.goto(link);
  expect(response?.status()).toBe(200);
  await expect(site).toHaveURL(`${siteOrigin}/time`);
  const redirect = await response!.request().redirectedFrom()!.response();
  expect(redirect?.status()).toBe(303);
  expect(await redirect!.headerValue("referrer-policy")).toBe("no-referrer");
  await expect(site.getByText(/^Diagnostics · .+ · Workshop$/)).toBeVisible();

  await site.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(1).click();
  await site.locator("button[data-start]:not([disabled])").first().click();
  await site.locator('button[form="time-form"]').click();
  await site.waitForURL(`${siteOrigin}/details`);
  await site.getByLabel("Full name").fill(CUSTOMER.name);
  await site.getByLabel("Mobile number").fill(CUSTOMER.typed);
  await site.getByRole("button", { name: "Confirm booking" }).click();
  await site.waitForURL(/\/confirmed\/[A-Z]+-\d{4,6}$/);
  reference = site.url().split("/").pop()!;

  const { data: booking } = await service.from("bookings").select("id,customer_id,vehicle_id,price_pence").eq("garage_id", garage.id).eq("reference", reference).single();
  expect(booking).toMatchObject({ customer_id: customerId, vehicle_id: vehicleId });
  const { data: send } = await service.from("campaign_sends").select("booking_id,opened_at").eq("id", sendId).single();
  expect(send?.booking_id).toBe(booking!.id);
  expect(send?.opened_at).toBeTruthy();
});

test("the campaign page shows sent, opened, the booking and the money won", async () => {
  test.setTimeout(120_000);
  await staffPage.goto(`${adminOrigin}/app/campaigns/${campaignId}`);
  const results = staffPage.getByRole("group", { name: "Results" });
  await expect(results).toContainText("Bookings");
  const pounds = `£${Math.floor(diagnostics.price_pence / 100)}`;
  await expect(results).toContainText(pounds);
  await expect(staffPage.getByText("Booked", { exact: true }).first()).toBeVisible();
  await expectAccessibleAt(staffPage, "results");

  await staffPage.goto(`${adminOrigin}/app/campaigns`);
  await expect(staffPage.getByRole("link", { name: "Winter check", exact: true })).toBeVisible();
  await expect(staffPage.getByRole("group", { name: "All campaigns" })).toContainText(pounds);
});

test("on Essentials the page is locked, earlier campaigns stay readable and the editor is refused", async () => {
  test.setTimeout(120_000);
  const moved = await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  expect(moved.error).toBeNull();
  await staffPage.goto(`${adminOrigin}/app/campaigns`);
  await expect(staffPage.getByRole("heading", { name: /Campaigns is on Pro/ })).toBeVisible();
  await expect(staffPage.getByRole("link", { name: "Winter check", exact: true })).toBeVisible();
  await expect(staffPage.getByRole("link", { name: "New campaign" })).toHaveCount(0);
  await expectAccessibleAt(staffPage, "locked");
  await staffPage.goto(`${adminOrigin}/app/campaigns/new?starter=win_back`);
  await expect(staffPage.getByRole("heading", { name: /Campaigns is on Pro/ })).toBeVisible();
  await expect(staffPage.getByRole("button", { name: /Save/ })).toHaveCount(0);

  expect(urls.filter((url) => compact(url).includes(REGISTRATION)), "registration in a URL").toEqual([]);
  expect(urls.filter((url) => url.includes(token) && url !== link), "token in a URL after the link").toEqual([]);
});
