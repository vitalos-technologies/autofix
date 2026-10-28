/**
 * P5.7 fleet and trade accounts (Pro, `fleet_accounts`) under playwright.garage.config.ts (project
 * `p5-fleet-accounts`) against the production build and local Supabase, messages on the mock channels.
 *
 * The spec makes its own garage (on Pro: a new garage's trial, seeded with the default services, hours and
 * bays), an owner with TOTP who signs in through the real screens, a second owner with an AAL2 token who
 * writes the invoice through the invoice RPCs (as the invoice form does) and a driver customer, and deletes
 * them afterwards. Journey: add an account; add a car by registration; add the driver by search; book that
 * car for the account from New booking (Account step, PO number; create_booking() through the staff path,
 * then set_booking_account()); the booking shows the account and PO; its invoice is billed to the account
 * and is not emailed on its own; make, issue, email (mock) and mark paid the month's statement; CSV and PDF;
 * then, with the garage on Essentials, the locked state with the account still readable. Axe (all rules) at
 * 390 and 1440 with no horizontal scroll on every new screen, screenshots into
 * docs/autofix/screenshots/phase-5/fleet-accounts-*, and no registration in any URL the browser requested.
 */
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, createLocalMfaIdentity, getLocalSupabaseConfig, localRunId, type LocalTestGarage, type LocalTestIdentity } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const SHOTS = "docs/autofix/screenshots/phase-5";
const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);
const REG = "FL22VAN";
const ACCOUNT = "Northern Vans Ltd";
const DRIVER = { name: "Dee Driver", phone: "+447700900463" };

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let owner: TotpMember;
let writer: LocalTestIdentity;
let context: BrowserContext;
let page: Page;
let accountId: string;
let bookingId: string;
let invoiceId: string;
let statementId: string;
const requested: string[] = [];

function londonDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  garage = await createLocalGarage(service, "fa");
  const seeded = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (seeded.error) throw new Error(`Could not seed the garage: ${seeded.error.message}`);
  const driver = await service.from("customers").insert({ garage_id: garage.id, name: DRIVER.name, phone: DRIVER.phone, preferred_contact: "phone" });
  if (driver.error) throw new Error(`Could not add the driver: ${driver.error.message}`);
  owner = await createTotpMember(service, garage.id, "owner", "fleet-owner");
  writer = await createLocalMfaIdentity(service, config.publishableKey, `fleet-writer-${localRunId}@example.test`);
  const membership = await service.from("garage_members").insert({ garage_id: garage.id, user_id: writer.id, role: "owner" });
  if (membership.error) throw new Error(`Could not add the invoice writer: ${membership.error.message}`);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on("request", (request) => requested.push(request.url()));
  await signInWithTotp(page, adminOrigin, owner);
});

test.afterAll(async () => {
  await context?.close();
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  for (const id of [owner?.id, writer?.id]) if (id) await service.auth.admin.deleteUser(id);
});

async function expectAccessibleAt(target: Page, shot: string) {
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
    await target.screenshot({ path: `${SHOTS}/fleet-accounts-${shot}-${width}.png`, fullPage: true });
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

test("the owner adds a fleet account", async () => {
  await page.goto(`${adminOrigin}/app/accounts`);
  await expect(page.getByRole("heading", { level: 1, name: "Fleet and trade accounts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No business accounts yet" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Fleet accounts" }).first()).toBeVisible();

  await page.getByRole("link", { name: "New account" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "New account" })).toBeVisible();
  await expectAccessibleAt(page, "new");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByText("Enter the business name (2 to 120 characters).")).toBeVisible();
  await page.getByLabel("Business name").fill(ACCOUNT);
  await page.getByLabel("Accounts email").fill("accounts@northern.example");
  await page.getByLabel("Payment terms").fill("14");
  await page.getByRole("checkbox", { name: "Needs a PO number on every booking" }).check();
  await page.getByLabel("Credit limit (optional)").fill("2500");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page).toHaveURL(/\/app\/accounts\/[0-9a-f-]{36}\?done=created$/);
  accountId = /accounts\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();
  const { data } = await service.from("business_accounts").select("garage_id,payment_terms_days,po_required,credit_limit_pence,billing").eq("id", accountId).single();
  expect(data).toEqual({ garage_id: garage.id, payment_terms_days: 14, po_required: true, credit_limit_pence: 250000, billing: "monthly" });
});

test("cars and drivers go on the account through POST forms", async () => {
  await page.goto(`${adminOrigin}/app/accounts/${accountId}`);
  await page.getByLabel("Or add a registration").fill("fl22 van");
  await page.getByLabel("Make (optional)").fill("Ford");
  await page.getByLabel("Model (optional)").fill("Transit");
  await page.getByRole("button", { name: "Add car" }).click();
  await expect(page.getByText("Car added to the account.")).toBeVisible();
  await expect(page.getByRole("region", { name: `Cars on ${ACCOUNT}` }).getByText("FL22 VAN")).toBeVisible();

  const people = page.locator("#people");
  await people.getByLabel("Add a driver or contact").fill("Dee");
  await people.getByRole("button", { name: "Find" }).click();
  await people.getByRole("button", { name: new RegExp(`^Add as driver\\s*: ${DRIVER.name}$`) }).click();
  await expect(page.getByText("Driver added.")).toBeVisible();
  await page.reload();
  await expect(people.getByRole("link", { name: DRIVER.name })).toBeVisible();

  const cars = await service.from("business_account_vehicles").select("vehicles(registration,make)").eq("account_id", accountId);
  expect(cars.data).toEqual([{ vehicles: { registration: REG, make: "Ford" } }]);
});

test("staff book the account's car with a PO through the staff booking path", async () => {
  test.setTimeout(60_000);
  await page.goto(`${adminOrigin}/app/bookings/new?account=${accountId}`);
  await expect(page.getByLabel("Charge to a business account")).toHaveValue(accountId);
  await page.getByLabel("Their car").selectOption(REG);
  await expect(page.getByRole("textbox", { name: "Registration" })).toHaveValue("FL22 VAN");
  await page.getByLabel("Driver").selectOption({ label: DRIVER.name });
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(DRIVER.name);
  const service_ = await page.locator("select option", { hasText: /^Full service/ }).first().getAttribute("value");
  await page.getByLabel("Service", { exact: true }).selectOption(service_ ?? "");
  await page.getByRole("checkbox", { name: "Outside opening hours" }).check();
  await page.getByLabel("Date and time").fill(`${londonDate(3)}T06:15`);
  await expectAccessibleAt(page, "booking");

  // The account needs a PO: the form stops before anything is sent (the server checks it again).
  await page.getByRole("button", { name: /^Book in for / }).click();
  await expect(page.getByText("Enter the PO number")).toBeVisible();
  await page.getByLabel("PO number").fill("PO-4410");
  await page.getByRole("button", { name: /^Book in for / }).click();
  await expect(page).toHaveURL(/\/app\/bookings\/[0-9a-f-]{36}\?notice=created$/);
  bookingId = /bookings\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByRole("link", { name: ACCOUNT })).toBeVisible();
  await expect(page.getByText("PO PO-4410")).toBeVisible();
  const { data } = await service.from("business_account_bookings").select("account_id,po_number").eq("booking_id", bookingId).single();
  expect(data).toEqual({ account_id: accountId, po_number: "PO-4410" });
  const { data: booking } = await service.from("bookings").select("source,status").eq("id", bookingId).single();
  expect(booking).toEqual({ source: "phone", status: "confirmed" });
});

test("the booking's invoice is billed to the account and waits for the statement", async () => {
  const writerClient = createLocalClient(config.publishableKey, writer.accessToken, garage.id);
  const draft = await writerClient.rpc("save_invoice_draft", {
    p_invoice_id: null,
    p_payload: { source_type: "booking", booking_id: bookingId, issue_date: londonDate(), items: [{ description: "Full service", quantity: "1", unit_price_pence: "18900" }] },
    p_confirm_duplicate_source: false,
  });
  expect(draft.error).toBeNull();
  invoiceId = String(draft.data);
  expect((await writerClient.rpc("issue_invoice", { p_invoice_id: invoiceId })).error).toBeNull();
  const { data: link } = await service.from("business_account_invoices").select("account_id,po_number,bill_to_name").eq("invoice_id", invoiceId).single();
  expect(link).toEqual({ account_id: accountId, po_number: "PO-4410", bill_to_name: ACCOUNT });

  await page.goto(`${adminOrigin}/app/invoices/${invoiceId}`);
  await expect(page.getByRole("heading", { name: "Charged to account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "On the monthly statement" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send PDF invoice" })).toHaveCount(0);
  const pdf = await page.request.get(`${adminOrigin}/api/admin/invoices/${invoiceId}/pdf`);
  expect(pdf.status()).toBe(200);

  await page.goto(`${adminOrigin}/app/accounts/${accountId}`);
  await expect(page.locator("#unbilled").getByRole("link", { name: /^[A-Z]{2,4}-\d{4}-\d{6}$/ })).toBeVisible();
  await expectAccessibleAt(page, "account");
});

test("the month's statement is made, issued, emailed (mock) and paid", async () => {
  await page.goto(`${adminOrigin}/app/accounts/${accountId}`);
  await page.getByLabel("Make or refresh a statement").selectOption(`${londonDate().slice(0, 7)}-01`);
  await page.getByRole("button", { name: "Make", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/accounts\/statements\/[0-9a-f-]{36}\?done=generated$/);
  statementId = /statements\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByRole("region", { name: /^Invoices on statement / }).getByText("£189.00")).toBeVisible();

  await page.getByRole("button", { name: "Issue statement" }).click();
  await expect(page.getByText("Statement issued. Email it to the account next.")).toBeVisible();
  await expect(page.getByLabel("Send to")).toHaveValue("accounts@northern.example");
  await expectAccessibleAt(page, "statement");
  await page.getByRole("button", { name: "Email statement" }).click();
  await expect(page.getByText("Statement emailed.")).toBeVisible();

  const csv = await page.request.get(`${adminOrigin}/api/admin/accounts/statements/${statementId}/csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text).toContain(`"${ACCOUNT}"`);
  expect(text).toContain('"PO-4410"');
  expect(text).toContain('"189.00"');
  const pdf = await page.request.get(`${adminOrigin}/api/admin/accounts/statements/${statementId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  await page.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByText("Statement marked paid. Its invoices are paid too.")).toBeVisible();
  const { data: statement } = await service.from("account_statements").select("status,email_status,emailed_to,invoice_count,total_pence,due_date,issue_date").eq("id", statementId).single();
  expect(statement).toMatchObject({ status: "paid", email_status: "sent", emailed_to: "accounts@northern.example", invoice_count: 1, total_pence: 18900 });
  expect(Date.parse(String(statement?.due_date)) - Date.parse(String(statement?.issue_date))).toBe(14 * 86_400_000);
  const { data: invoice } = await service.from("invoices").select("status").eq("id", invoiceId).single();
  expect(invoice).toEqual({ status: "paid" });
});

test("the account list shows the account", async () => {
  await page.goto(`${adminOrigin}/app/accounts`);
  await expect(page.getByRole("link", { name: new RegExp(ACCOUNT) })).toBeVisible();
  await expectAccessibleAt(page, "list");
});

test("on Essentials the section is locked and the account stays readable", async () => {
  await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  await page.goto(`${adminOrigin}/app/accounts`);
  await expect(page.getByText("Fleet and trade accounts is on Pro")).toBeVisible();
  await expect(page.getByText("Everything you added on Pro is kept.")).toBeVisible();
  await expect(page.getByRole("link", { name: "New account" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: new RegExp(ACCOUNT) })).toBeVisible();
  await expectAccessibleAt(page, "locked");
  await page.goto(`${adminOrigin}/app/accounts/new`);
  await expect(page.getByRole("heading", { level: 1, name: "New account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
  await page.goto(`${adminOrigin}/app/accounts/${accountId}`);
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add car" })).toHaveCount(0);
  // The database refuses writes too (write policies check the plan).
  const writerClient = createLocalClient(config.publishableKey, writer.accessToken, garage.id);
  const update = await writerClient.from("business_accounts").update({ notes: "changed" }).eq("id", accountId).select("id");
  expect(update.error?.code).toBe("42501");
  const rpc = await writerClient.rpc("generate_account_statement", { p_account_id: accountId, p_period_start: `${londonDate().slice(0, 7)}-01` });
  expect(rpc.error?.message).toBe("PLAN_REQUIRED: fleet_accounts");
});

test("no registration appeared in any URL", () => {
  const leaks = requested.filter((url) => decodeURIComponent(url).toUpperCase().replace(/[^A-Z0-9]/g, "").includes(REG));
  expect(leaks).toEqual([]);
});
