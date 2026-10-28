/**
 * P5.4 Payments, end to end on the production build, local Supabase and the MOCK payments provider
 * (`PAYMENTS_PROVIDER` unset = mock: no money moves). Project `p5-payments`, `pnpm test:e2e:p5-payments`.
 *
 * The spec makes its own Pro (trial) garage with the default services, an owner with TOTP, and deletes it all
 * afterwards. In order:
 *   1. the owner connects payments and sets a £20 deposit, a 30-minute hold and a £25 no-show fee;
 *   2. a customer (390px) books a Full service: the booking is made through create_booking() and holds the slot,
 *      the confirmation is held back, and /pay asks for the £20 deposit; paying it (mock) confirms the booking
 *      and queues the confirmation;
 *   3. a second customer books and never pays: once the hold has run out the booking is cancelled ("Deposit not
 *      paid in time") and the slot is free again;
 *   4. the first booking is marked a no-show; the owner charges the no-show fee by link (sent by text on the mock
 *      channel); the customer opens the link (/pay/<token> → /pay, no-referrer) and pays;
 *   5. an issued invoice is sent to pay by link and paid online: recorded in invoice_payments, invoice paid;
 *   6. /app/payments lists all of it with this month's totals;
 *   7. on Essentials the pages show the locked state, and online booking takes no deposit.
 * axe runs with every rule at 390 and 1440 on every new screen, screenshots go to docs/autofix/screenshots/phase-5,
 * and no request or navigation URL ever holds the registration (or a pay token after its own link).
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
const PAYER = { name: "Penny Payer", phone: "+447700900488", typed: "07700 900488" };
const LATE = { name: "Larry Late", typed: "07700 900489" };
const LATER = { name: "Essie Booker", typed: "07700 900490" };
const REGISTRATIONS = [randomRegistration(), randomRegistration(), randomRegistration()];

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let siteOrigin: string;
let owner: TotpMember;
let admin: BrowserContext;
let staff: Page;
let customer: BrowserContext;
let site: Page;
const urls: string[] = [];
const tokens: string[] = [];
let paidBookingId: string;
let customerId: string;
const invoiceId = crypto.randomUUID();

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
    if (shot) await page.screenshot({ path: `${SHOTS}/payments-${shot}-${width}.png`, fullPage: true });
  }
  if (own) await page.setViewportSize(own);
}

/** Steps 1 to 4 for a Full service on the n-th open day; stops on the details step. */
async function bookToDetails(page: Page, registration: string, name: string, phone: string, dayIndex: number) {
  await page.goto(`${siteOrigin}/`);
  await page.getByLabel("Registration").fill(registration);
  await page.getByRole("button", { name: "Enter details manually" }).click();
  await page.getByLabel("Make").fill("Ford");
  await page.getByLabel("Model").fill("Focus");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/service$/);
  await page.getByRole("radio", { name: /Full service/ }).check();
  await page.getByRole("button", { name: "Choose a time" }).click();
  await page.waitForURL(/\/time/);
  await page.getByRole("group", { name: "Choose a day" }).locator("button:not([disabled])").nth(dayIndex).click();
  const slot = page.locator("button[data-start]:not([disabled])").first();
  const startsAt = (await slot.getAttribute("data-start"))!;
  await slot.click();
  await page.locator('button[form="time-form"]').click();
  await page.waitForURL(/\/details$/);
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Mobile number").fill(phone);
  return startsAt;
}

async function latestBooking(startsAt: string) {
  const { data, error } = await service.from("bookings").select("id,status,cancellation_reason,customer_id").eq("garage_id", garage.id).eq("starts_at", startsAt).order("created_at", { ascending: false }).limit(1).single();
  if (error || !data) throw new Error(`booking at ${startsAt}: ${error?.message}`);
  return data as { id: string; status: string; cancellation_reason: string | null; customer_id: string };
}

async function paymentsFor(column: "booking_id" | "invoice_id", id: string) {
  const { data } = await service.from("payments").select("id,kind,status,amount_pence,amount_paid_pence,notify_channel,notify_outcome,token_hash").eq("garage_id", garage.id).eq(column, id).order("created_at");
  return (data ?? []) as Array<{ id: string; kind: string; status: string; amount_pence: number; amount_paid_pence: number | null; notify_channel: string | null; notify_outcome: string | null }>;
}

/** free_count of the Full service slot starting at `startsAt` (available_slots(), service role). */
async function freeCount(startsAt: string) {
  const { data: svc } = await service.from("services").select("id").eq("garage_id", garage.id).eq("name", "Full service").single();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(startsAt));
  const { data, error } = await service.rpc("available_slots", { p_garage_id: garage.id, p_service_id: svc!.id, p_from: day, p_to: day, p_location_mode: "workshop" });
  if (error) throw new Error(`available_slots: ${error.message}`);
  const slot = (data as Array<{ starts_at: string; free_count: number }>).find((row) => Date.parse(row.starts_at) === Date.parse(startsAt));
  return slot?.free_count ?? 0;
}

async function confirmationJob(bookingId: string) {
  const { data } = await service.from("jobs").select("id").eq("dedupe_key", `notifications.booking:${garage.id}:${bookingId}:created:once`);
  return (data ?? []).length;
}

/** The pay link in the newest text to the customer. */
async function linkFromMessages() {
  const { data } = await service.from("messages").select("body").eq("garage_id", garage.id).eq("direction", "outbound").order("created_at", { ascending: false }).limit(1).single();
  // The production build links to the garage's public host; the token is opened on its local host here.
  const found = new RegExp(`https?://${garage.slug.replace(/[-.]/g, "\\$&")}\\.[^/\\s]+/pay/([A-Za-z0-9_-]{43})(?=\\s)`).exec(String(data?.body ?? ""));
  expect(found, `a pay link in "${data?.body}"`).not.toBeNull();
  tokens.push(found![1]!);
  return `${siteOrigin}/pay/${found![1]!}`;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "py");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (defaults.error) throw new Error(`Could not seed the garage: ${defaults.error.message}`);
  owner = await createTotpMember(service, garage.id, "owner", "p5-payments-owner");
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  staff = await admin.newPage();
  customer = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.154" } });
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

test("the owner connects payments and sets the deposit and no-show fee", async () => {
  test.setTimeout(120_000);
  await signInWithTotp(staff, adminOrigin, owner);
  await staff.goto(`${adminOrigin}/app/payments`);
  await expect(staff.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  await expect(staff.getByText(/No payment account is connected/)).toBeVisible();
  await expect(staff.getByRole("link", { name: /Payments/ }).first()).toBeVisible();

  await staff.getByRole("link", { name: "Payment settings", exact: true }).click();
  await expect(staff.getByRole("heading", { level: 1, name: "Payment settings" })).toBeVisible();
  await staff.getByRole("button", { name: "Connect payments" }).click();
  await expect(staff.getByText("Payments connected. Deposits and payment links can be used now.")).toBeVisible();
  await expect(staff.getByText("Connected", { exact: true })).toBeVisible();

  await staff.getByLabel("Take a deposit when customers book online").check();
  await staff.getByLabel("Default deposit for every service").selectOption("fixed");
  await staff.getByLabel("Amount").fill("20");
  await staff.getByLabel("No-show fee").fill("25");
  await staff.getByRole("button", { name: "Save payment settings" }).click();
  await expect(staff.getByText("Payment settings saved.")).toBeVisible();
  await staff.reload();
  await expect(staff.getByRole("row", { name: /Full service/ })).toContainText("£20.00");
  await check(staff, "settings");

  const { data: account } = await service.from("payment_accounts").select("provider,status,charges_enabled").eq("garage_id", garage.id).single();
  expect(account).toEqual({ provider: "mock", status: "active", charges_enabled: true });
});

test("a deposit holds the booking until it is paid, then the confirmation goes", async () => {
  test.setTimeout(120_000);
  const startsAt = await bookToDetails(site, REGISTRATIONS[0]!, PAYER.name, PAYER.typed, 1);
  await expect(site.getByText(/£20\.00 deposit now; we hold your time for 30 minutes/)).toBeVisible();
  await site.getByRole("button", { name: "Confirm and pay deposit" }).click();
  await site.waitForURL(`${siteOrigin}/pay`);
  await expect(site.getByRole("heading", { level: 1, name: "Pay your deposit" })).toBeVisible();
  await expect(site.getByText("Test payment: no card is needed and no money moves.")).toBeVisible();
  const pay = (await customer.cookies()).find((cookie) => cookie.name === "af_pay");
  expect(pay).toMatchObject({ httpOnly: true, path: "/pay", sameSite: "Lax" });

  const booking = await latestBooking(startsAt);
  paidBookingId = booking.id;
  customerId = booking.customer_id;
  expect(booking.status).toBe("confirmed");
  expect(await paymentsFor("booking_id", booking.id)).toEqual([expect.objectContaining({ kind: "deposit", status: "pending", amount_pence: 2000 })]);
  expect(await confirmationJob(booking.id), "the confirmation waits for the deposit").toBe(0);
  await check(site, "pay-deposit");

  await site.getByRole("button", { name: "Pay £20.00" }).click();
  await site.waitForURL(`${siteOrigin}/pay?done=1`);
  await expect(site.getByText("Paid £20.00. Thank you.")).toBeVisible();
  await expect(site.getByText("Your booking is confirmed.", { exact: false })).toBeVisible();
  await check(site, "pay-paid");
  expect(await paymentsFor("booking_id", booking.id)).toEqual([expect.objectContaining({ kind: "deposit", status: "paid", amount_paid_pence: 2000 })]);
  await expect.poll(() => confirmationJob(booking.id), { message: "the confirmation is queued once paid" }).toBe(1);
});

test("an unpaid deposit releases the slot when its hold runs out", async ({ browser }) => {
  test.setTimeout(120_000);
  const late = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.155" } });
  watch(late);
  const page = await late.newPage();
  const startsAt = await bookToDetails(page, REGISTRATIONS[1]!, LATE.name, LATE.typed, 2);
  await page.getByRole("button", { name: "Confirm and pay deposit" }).click();
  await page.waitForURL(`${siteOrigin}/pay`);
  const booking = await latestBooking(startsAt);
  expect(booking.status).toBe("confirmed");
  const whileHeld = await freeCount(startsAt);

  // The hold runs out.
  const expired = await service.from("payments").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("garage_id", garage.id).eq("booking_id", booking.id).select("id");
  expect(expired.data).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("This payment link has expired")).toBeVisible();
  await expect(page.getByRole("link", { name: "Book again" })).toBeVisible();
  await check(page, "pay-expired");
  const released = await latestBooking(startsAt);
  expect(released).toMatchObject({ status: "cancelled", cancellation_reason: "Deposit not paid in time" });
  expect(await paymentsFor("booking_id", booking.id)).toEqual([expect.objectContaining({ status: "expired" })]);
  expect(await confirmationJob(booking.id)).toBe(0);

  // The bay it held is free again for the next customer.
  expect(await freeCount(startsAt)).toBe(whileHeld + 1);
  await late.close();
});

test("the owner charges the no-show fee by link and the customer pays it", async () => {
  test.setTimeout(120_000);
  await service.from("bookings").update({ status: "no_show" }).eq("id", paidBookingId);
  await staff.goto(`${adminOrigin}/app/bookings/${paidBookingId}`);
  const panel = staff.locator("#payments");
  await expect(panel).toContainText("Deposit · £20.00");
  await panel.getByRole("button", { name: "Charge no-show fee (£25.00)" }).click();
  await expect(staff).toHaveURL(/payments=link_sent/);
  await expect(staff.getByText("Payment link sent to the customer.")).toBeVisible();
  await expect(panel).toContainText("No-show fee · £25.00");
  await expect(panel).toContainText(/Sent by text/);
  await check(staff, "booking-panel");

  const link = await linkFromMessages();
  const response = await site.goto(link);
  expect(response?.status()).toBe(200);
  await expect(site).toHaveURL(`${siteOrigin}/pay`);
  const redirect = await response!.request().redirectedFrom()!.response();
  expect(redirect?.status()).toBe(303);
  expect(await redirect!.headerValue("referrer-policy")).toBe("no-referrer");
  await expect(site.getByRole("heading", { level: 1, name: "Missed appointment fee" })).toBeVisible();
  await site.getByRole("button", { name: "Pay £25.00" }).click();
  await expect(site.getByText("Paid £25.00. Thank you.")).toBeVisible();
  expect(await paymentsFor("booking_id", paidBookingId)).toEqual([
    expect.objectContaining({ kind: "deposit", status: "paid" }),
    expect.objectContaining({ kind: "no_show_fee", status: "paid", notify_channel: "sms", notify_outcome: "sent" }),
  ]);
});

test("an invoice is sent to pay by link and settled online", async () => {
  test.setTimeout(120_000);
  executeLocalOwnerSql(`
    begin;
    insert into public.invoices (id, garage_id, status, source_type, customer_name, customer_id, customer_phone, issue_date, created_by, updated_by)
    values (:'invoice', :'garage', 'draft', 'manual', 'Penny Payer', :'customer', '+447700900488', current_date, :'owner', :'owner');
    insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence)
    values (:'garage', :'invoice', 'Brake pads (front)', 1, 6000, 0);
    select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated', 'aal', 'aal2')::text, true);
    select set_config('request.headers', json_build_object('x-garage-id', :'garage')::text, true);
    set local role authenticated;
    select public.issue_invoice(:'invoice');
    commit;
  `, { invoice: invoiceId, garage: garage.id, customer: customerId, owner: owner.id });

  await staff.goto(`${adminOrigin}/app/invoices/${invoiceId}`);
  await staff.getByRole("button", { name: "Send payment link (£60.00)" }).click();
  await expect(staff).toHaveURL(/payments=link_sent/);
  await expect(staff.getByText("Payment link sent to the customer.")).toBeVisible();
  await staff.locator("#payments").screenshot({ path: `${SHOTS}/payments-invoice-panel-1440.png` });
  await staff.goto(`${adminOrigin}/app/invoices`);
  await expect(staff.getByText("Link sent").first()).toBeVisible();

  const link = await linkFromMessages();
  await site.goto(link);
  await expect(site.getByRole("heading", { level: 1, name: /^Invoice / })).toBeVisible();
  await check(site, "pay-invoice");
  await site.getByRole("button", { name: "Pay £60.00" }).click();
  await expect(site.getByText("Paid £60.00. Thank you.")).toBeVisible();

  const { data: invoice } = await service.from("invoices").select("status,payment_method").eq("id", invoiceId).single();
  expect(invoice).toEqual({ status: "paid", payment_method: "card" });
  const { data: recorded } = await service.from("invoice_payments").select("amount_pence,payment_method").eq("invoice_id", invoiceId);
  expect(recorded).toEqual([{ amount_pence: 6000, payment_method: "card" }]);
  await staff.goto(`${adminOrigin}/app/invoices`);
  await expect(staff.getByText("Paid online").first()).toBeVisible();
});

test("Payments lists every payment with this month's totals", async () => {
  await staff.goto(`${adminOrigin}/app/payments`);
  await expect(staff.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  const paid = staff.locator("dl").filter({ has: staff.getByRole("term").filter({ hasText: "Paid this month" }) });
  await expect(paid.locator("dd").first()).toHaveText("£105.00");
  await expect(staff.getByRole("table")).toContainText("No-show fee");
  await expect(staff.getByRole("table")).toContainText("Expired");
  await check(staff, "list");
  await staff.getByRole("link", { name: "Deposits", exact: true }).click();
  await expect(staff).toHaveURL(/kind=deposit/);
  await expect(staff.getByRole("table")).not.toContainText("No-show fee");

  expect(urls.filter((url) => REGISTRATIONS.some((registration) => compact(url).includes(registration))), "registration in a URL").toEqual([]);
  expect(urls.filter((url) => tokens.some((token) => url.includes(token)) && !url.endsWith(`/pay/${tokens.find((token) => url.includes(token))}`)), "pay token in a URL").toEqual([]);
});

test("on Essentials payments are locked and online booking takes no deposit", async () => {
  test.setTimeout(120_000);
  const essentials = await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  expect(essentials.error).toBeNull();

  await staff.goto(`${adminOrigin}/app/payments`);
  await expect(staff.getByText("Deposits and pay-by-link is on Pro")).toBeVisible();
  await expect(staff.getByText(/Everything you added on Pro is kept/)).toBeVisible();
  await check(staff, "locked");
  await staff.goto(`${adminOrigin}/app/payments/settings`);
  await expect(staff.getByText("Deposits and pay-by-link is on Pro")).toBeVisible();
  await check(staff, "settings-locked");

  const startsAt = await bookToDetails(site, REGISTRATIONS[2]!, LATER.name, LATER.typed, 3);
  await expect(site.getByText("Nothing to pay now.")).toBeVisible();
  await site.getByRole("button", { name: "Confirm booking" }).click();
  await site.waitForURL(/\/confirmed\/[A-Z]+-\d{4,6}$/);
  const booking = await latestBooking(startsAt);
  expect(await paymentsFor("booking_id", booking.id)).toEqual([]);
  await expect.poll(() => confirmationJob(booking.id), { message: "the confirmation goes straight away" }).toBe(1);
});
