/**
 * P5.11 Customer service plans, end to end on the production build, local Supabase and the MOCK payments
 * provider (`PAYMENTS_PROVIDER` unset = mock: no bank details, no money). Project `p5-service-plans`,
 * `pnpm test:e2e:p5-service-plans`.
 *
 * The spec makes its own Pro (trial) garage with the default services and an owner with TOTP, and deletes it
 * all afterwards. In order:
 *   1. the owner connects payments and adds a plan at /app/service-plans: £19.99 a month, Full service included
 *      once a year, 10% off, priority booking;
 *   2. a customer (390px) opens /plans on the garage host, joins the plan (details, car, the Direct Debit
 *      Guarantee, authorisation), sets up the test Direct Debit on /plans/confirm; the subscription is active and
 *      the sign-up confirmation went out by text (mock channel);
 *   3. the customer books a Full service online for that car: create_booking() makes the booking and the plan's
 *      included use is recorded after it; staff see "On Gold care" on the booking;
 *   4. on the booking's draft invoice staff apply the plan: the Full service line goes to £0.00 and 10% comes off
 *      the rest;
 *   5. on Essentials, /app/service-plans is locked (with the customers still paying flagged) and /plans says plans
 *      aren't available; staff can still cancel the customer's plan from the customer page.
 * axe runs with every rule at 390 and 1440 on every new screen, screenshots go to docs/autofix/screenshots/phase-5,
 * and no request or navigation URL ever holds the registration.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { randomRegistration } from "../helpers/booking-fixtures";
import { createLocalClient, createLocalGarage, executeLocalOwnerSql, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const SHOTS = "docs/autofix/screenshots/phase-5";
const MEMBER = { name: "Sally Subscriber", phone: "+447700900511", typed: "07700 900511" };
const REGISTRATION = randomRegistration();

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let siteOrigin: string;
let owner: TotpMember;
let admin: BrowserContext;
let staff: Page;
let customer: BrowserContext;
let site: Page;
const urls: string[] = [];
let bookingId: string;
let subscriptionId: string;
let customerId: string;

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

/** Every rule at 390 and 1440, one <main>, no horizontal scroll; screenshots when named. */
async function check(page: Page, shot?: string) {
  const path = new URL(page.url()).pathname;
  const own = page.viewportSize();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(page).toHaveTitle(/\S/);
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    await expect(page.locator("main")).toHaveCount(1);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `axe at ${width}px on ${path}`).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px on ${path}` }).toBeLessThanOrEqual(1);
    if (shot) await page.screenshot({ path: `${SHOTS}/service-plans-${shot}-${width}.png`, fullPage: true });
  }
  if (own) await page.setViewportSize(own);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  garage = await createLocalGarage(service, "sp");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (defaults.error) throw new Error(`Could not seed the garage: ${defaults.error.message}`);
  owner = await createTotpMember(service, garage.id, "owner", "p5-service-plans-owner");
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  staff = await admin.newPage();
  customer = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.161" } });
  watch(admin);
  watch(customer);
  site = await customer.newPage();
});

test.afterAll(async () => {
  await admin?.close();
  await customer?.close();
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  if (owner) await service.auth.admin.deleteUser(owner.id);
});

test("the owner connects payments and adds a plan", async () => {
  await signInWithTotp(staff, adminOrigin, owner);
  await staff.goto(`${adminOrigin}/app/service-plans`);
  await expect(staff.getByRole("heading", { level: 1, name: "Service plans" })).toBeVisible();
  await expect(staff.getByText(/Connect payments before customers can join/)).toBeVisible();
  await expect(staff.getByRole("link", { name: /Service plans/ }).first()).toBeVisible();

  await staff.goto(`${adminOrigin}/app/payments/settings`);
  await staff.getByRole("button", { name: "Connect payments" }).click();
  await expect(staff.getByText("Payments connected. Deposits and payment links can be used now.")).toBeVisible();

  await staff.goto(`${adminOrigin}/app/service-plans`);
  await expect(staff.getByText("No plans yet")).toBeVisible();
  const form = staff.locator("#add-plan");
  await form.getByLabel("Plan name").fill("Gold care");
  await form.getByLabel("Monthly price (£)").fill("19.99");
  await form.getByLabel("Discount on parts and labour (%)").fill("10");
  await form.getByLabel("Priority booking").check();
  await form.getByLabel("Full service", { exact: true }).check();
  await form.getByRole("button", { name: "Add plan" }).click();
  await expect(staff.getByText("Plan added. Customers can join it on your booking site now.")).toBeVisible();
  await expect(staff.getByRole("heading", { level: 3, name: "Gold care" })).toBeVisible();
  await expect(staff.getByText("£19.99 a month").first()).toBeVisible();
  await expect(staff.getByText("Full service included once a year").first()).toBeVisible();
  await check(staff, "admin");

  const { data: plan } = await service.from("service_plans").select("price_pence,discount_percent,priority_booking,status,service_plan_inclusions(uses_per_year)").eq("garage_id", garage.id).single();
  expect(plan).toEqual({ price_pence: 1999, discount_percent: 10, priority_booking: true, status: "active", service_plan_inclusions: [{ uses_per_year: 1 }] });
});

test("a customer joins on the garage host and sets up the (test) Direct Debit", async () => {
  await site.goto(`${siteOrigin}/plans`);
  await expect(site.getByRole("heading", { level: 1, name: "Look after your car for a monthly fee" })).toBeVisible();
  await check(site, "public-list");
  await site.getByRole("link", { name: "Join Gold care" }).click();
  await site.waitForURL(/\/plans\/[0-9a-f-]{36}$/);
  await expect(site.getByRole("heading", { level: 1, name: "Join Gold care" })).toBeVisible();
  await expect(site.getByRole("heading", { name: "The Direct Debit Guarantee" })).toBeVisible();
  await expect(site.getByText(/full and immediate refund/)).toBeVisible();

  // Nothing filled: every problem is named.
  await site.getByRole("button", { name: "Set up Direct Debit" }).click();
  await expect(site.getByText("Enter your full name.")).toBeVisible();
  await expect(site.getByText("Confirm you can authorise Direct Debits from the account.")).toBeVisible();
  await check(site, "signup");

  await site.getByLabel("Full name").fill(MEMBER.name);
  await site.getByLabel("Mobile number").fill(MEMBER.typed);
  await site.getByLabel("Registration").fill(REGISTRATION);
  await site.getByLabel("Make (optional)").fill("Ford");
  await site.getByLabel("Model (optional)").fill("Fiesta");
  await site.getByLabel(/I'm the account holder/).check();
  await site.getByRole("button", { name: "Set up Direct Debit" }).click();
  await site.waitForURL(`${siteOrigin}/plans/confirm`);
  await expect(site.getByRole("heading", { level: 1, name: "Set up your Direct Debit" })).toBeVisible();
  const cookie = (await customer.cookies()).find((item) => item.name === "af_plan");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.path).toBe("/plans");
  await check(site, "confirm-pending");

  await site.getByRole("button", { name: "Set up test Direct Debit" }).click();
  await expect(site.getByRole("heading", { level: 1, name: "You're on Gold care" })).toBeVisible();
  await expect(site.getByText("Your Direct Debit is set up. Thank you.")).toBeVisible();
  await check(site, "confirm-active");

  const { data: subscription } = await service.from("customer_plan_subscriptions").select("id,status,price_pence,provider,customer_id,started_at,last_notice_kind,last_notice_outcome").eq("garage_id", garage.id).single();
  expect(subscription).toMatchObject({ status: "active", price_pence: 1999, provider: "mock", last_notice_kind: "confirmation", last_notice_outcome: "sent" });
  subscriptionId = subscription!.id;
  customerId = subscription!.customer_id;
  const { data: message } = await service.from("messages").select("body,channel").eq("garage_id", garage.id).eq("direction", "outbound").order("created_at", { ascending: false }).limit(1).single();
  expect(message?.channel).toBe("sms");
  expect(message?.body).toMatch(/you're on our Gold care plan for your Ford Fiesta/);
  expect(compact(String(message?.body))).not.toContain(REGISTRATION.replace(/\s/g, ""));
});

test("an online booking for the car uses the included service, and staff see the plan", async () => {
  await site.goto(`${siteOrigin}/`);
  // Open manual entry first, retrying until the page has hydrated (a plate typed before hydration is reset).
  await expect(async () => {
    await site.getByRole("button", { name: "Enter details manually" }).click({ timeout: 2_000 });
    await expect(site.getByLabel("Make")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  // Opening manual entry moves focus to Make on the next frame; wait for it so the plate isn't typed into Make.
  await expect(site.getByLabel("Make")).toBeFocused();
  await site.getByLabel("Registration").fill(REGISTRATION);
  await expect(site.getByLabel("Registration")).not.toHaveValue("");
  await site.getByLabel("Make").fill("Ford");
  await site.getByLabel("Model").fill("Fiesta");
  await site.getByRole("button", { name: "Continue" }).click();
  await site.waitForURL(/\/service$/);
  await site.getByRole("radio", { name: /Full service/ }).check();
  await site.getByRole("button", { name: "Choose a time" }).click();
  await site.waitForURL(/\/time/);
  await site.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(1).click();
  const slot = site.locator("button[data-start]:not([disabled])").first();
  const startsAt = (await slot.getAttribute("data-start"))!;
  await slot.click();
  await site.locator('button[form="time-form"]').click();
  await site.waitForURL(/\/details$/);
  await site.getByLabel("Full name").fill(MEMBER.name);
  await site.getByLabel("Mobile number").fill(MEMBER.typed);
  await site.getByRole("button", { name: "Confirm booking" }).click();
  await site.waitForURL(/\/confirmed\//);

  const { data: booking } = await service.from("bookings").select("id,vehicle_id").eq("garage_id", garage.id).eq("starts_at", startsAt).single();
  bookingId = booking!.id;
  const { data: uses } = await service.from("service_plan_uses").select("status,source,subscription_id").eq("booking_id", bookingId);
  expect(uses).toEqual([{ status: "used", source: "online", subscription_id: subscriptionId }]);

  await staff.goto(`${adminOrigin}/app/bookings/${bookingId}`);
  const panel = staff.locator("#service-plan");
  await expect(panel.getByRole("heading", { name: "On Gold care" })).toBeVisible();
  await expect(panel.getByText("This booking uses the plan's included Full service.")).toBeVisible();
  await expect(panel.getByText("Priority booking: fit this customer in first.")).toBeVisible();
  await check(staff, "booking");
});

test("plan benefits go on the booking's draft invoice", async () => {
  executeLocalOwnerSql(`
    begin;
    select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated', 'aal', 'aal2')::text, true);
    select set_config('request.headers', json_build_object('x-garage-id', :'garage')::text, true);
    set local role authenticated;
    select public.save_invoice_draft(null, json_build_object(
      'source_type', 'booking', 'booking_id', :'booking',
      'items', json_build_array(
        json_build_object('description', 'Full service', 'quantity', 1, 'unit_price_pence', 18900),
        json_build_object('description', 'Wiper blades', 'quantity', 1, 'unit_price_pence', 2000)))::jsonb, false);
    commit;
  `, { owner: owner.id, garage: garage.id, booking: bookingId });
  const { data: invoice } = await service.from("invoices").select("id").eq("garage_id", garage.id).eq("booking_id", bookingId).single();

  await staff.goto(`${adminOrigin}/app/invoices/${invoice!.id}`);
  const panel = staff.locator("#service-plan");
  await expect(panel.getByRole("heading", { name: "On Gold care" })).toBeVisible();
  await panel.getByRole("button", { name: "Apply plan benefits" }).click();
  await expect(staff.getByText("Plan benefits added to the draft invoice.")).toBeVisible();
  await expect(staff.getByRole("cell", { name: "Full service (included in Gold care)" })).toBeVisible();
  await check(staff, "invoice");

  const { data: totals } = await service.from("invoices").select("subtotal_pence,discount_pence,total_pence").eq("id", invoice!.id).single();
  expect(totals).toEqual({ subtotal_pence: 2000, discount_pence: 200, total_pence: 1800 });
});

test("on Essentials the page is locked, the public page closed, and staff can still cancel", async () => {
  const downgraded = await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  expect(downgraded.error).toBeNull();

  await staff.goto(`${adminOrigin}/app/service-plans`);
  await expect(staff.getByRole("heading", { level: 1, name: "Service plans" })).toBeVisible();
  await expect(staff.getByText(/1 customer is still on a plan\. Their Direct Debits keep being collected/)).toBeVisible();
  await expect(staff.getByRole("button", { name: "Add plan" })).toHaveCount(0);
  await check(staff, "locked");

  await site.goto(`${siteOrigin}/plans`);
  await expect(site.getByRole("heading", { level: 1, name: "Service plans aren't available" })).toBeVisible();
  await check(site, "public-unavailable");

  await staff.goto(`${adminOrigin}/app/customers/${customerId}`);
  const panel = staff.locator("#service-plan");
  await expect(panel.getByText("Full service: 1 of 1 used")).toBeVisible();
  await panel.getByText("Cancel plan").click();
  await panel.getByLabel("Reason (optional)").fill("Moving away");
  await panel.getByRole("button", { name: "Stop Direct Debit and cancel" }).click();
  await expect(staff.getByText("Plan cancelled. The Direct Debit has been stopped.")).toBeVisible();
  await check(staff, "customer");
  const { data: cancelled } = await service.from("customer_plan_subscriptions").select("status,cancel_reason").eq("id", subscriptionId).single();
  expect(cancelled).toEqual({ status: "cancelled", cancel_reason: "Moving away" });
});

test("no URL ever held the registration", () => {
  const plate = REGISTRATION.replace(/\s/g, "").toUpperCase();
  const leaked = urls.filter((url) => compact(url).includes(plate));
  expect(leaked).toEqual([]);
});
