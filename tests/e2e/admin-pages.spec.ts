/**
 * Every admin page reachable from the admin shell, visited by a signed-in owner with axe (every rule) at 390 and
 * 1440 (P3.12), plus light journeys for the pages no other spec drives: Customers (list, search, detail, import),
 * Enquiries (inbox → thread; another garage's, a trashed and a missing thread show nothing; this replaces SOB's
 * admin-enquiries.spec.ts, which only ran with hand-made fixture ids, DECISIONS A189), Quotes & invoices (list, new,
 * a draft and its edit page) and Trash. Runs under playwright.garage.config.ts (project `admin-pages`, part of
 * `pnpm test:e2e:admin`) against the production build and local Supabase.
 *
 * The spec makes its own garage (MOT on, `seed_garage_defaults()`) with a customer, a car, two enquiries (one in
 * the trash) and a draft invoice, and a second garage with one enquiry; an owner with TOTP signs in through the real
 * password + MFA screens. Everything it makes is deleted afterwards (the garages cascade to their rows).
 *
 * The sweep reads the links from the shell itself (sidebar, header, account menu and bell at 1440; tab bar and
 * header at 390), so a page added to the nav is checked without editing this file. It must find at least
 * `SHELL_PAGES`. Pages in `NOT_BUILT_YET` are in the nav before they exist and may answer 404 (the shell's or the
 * root not-found page, axe-checked like the rest); every other page must answer 200 without sending the owner to
 * sign in again.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { randomRegistration } from "../helpers/booking-fixtures";
import {
  createLocalClient,
  createLocalGarage,
  createLocalMfaIdentity,
  getLocalSupabaseConfig,
  invoiceDraftPayload,
  localRunId,
  type LocalTestGarage,
  type LocalTestIdentity,
} from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);

/** What the shell links to today (defaultAdminNav, the account menu, the bell and the phone tab bar). */
const SHELL_PAGES = [
  "/app",
  "/app/diary",
  "/app/bookings",
  "/app/invoices",
  "/app/enquiries",
  "/app/customers",
  "/app/reminders",
  "/app/messages",
  "/app/settings/services",
  "/app/settings/hours",
  "/app/settings/resources",
  "/app/settings/branding",
  "/app/settings/booking-page",
  "/app/settings/team",
  "/app/settings/agreements",
  "/app/settings",
  "/app/configuration/security",
  "/app/notifications",
  "/app/trash",
  "/app/more",
];
/** In the nav ahead of its page (Messages & calls has no task in BUILD-PLAN yet). */
const NOT_BUILT_YET = new Set(["/app/messages"]);

const CUSTOMER = { name: "Priya Sweep", phone: "+447700900478", email: `priya-${localRunId}@example.test`, registration: randomRegistration() };

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let otherGarage: LocalTestGarage;
let owner: TotpMember;
let writer: LocalTestIdentity;
let context: BrowserContext;
let page: Page;
let customerId: string;
let enquiryId: string;
let trashedEnquiryId: string;
let otherEnquiryId: string;
let invoiceId: string;

function londonDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

/** Every rule at 390 and 1440: one <main>, one visible h1, no violations, no horizontal scroll. */
async function expectAccessibleAt(target: Page) {
  const path = new URL(target.url()).pathname;
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    await expect(target.locator("main"), `one <main> on ${path}`).toHaveCount(1);
    await expect(target.locator("h1:visible"), `one visible h1 at ${width}px on ${path}`).toHaveCount(1);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px on ${path}`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px on ${path}` }).toBeLessThanOrEqual(1);
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

/** The admin links in the shell (navigation landmarks and headers) at the current width, without query or hash. */
async function shellLinks(target: Page) {
  const hrefs = await target.locator("nav a[href^='/app'], header a[href^='/app']").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  return hrefs.map((href) => new URL(href, "http://shell.test").pathname.replace(/\/$/, "") || "/app");
}

async function insertCustomer(garageId: string, values: Record<string, unknown>) {
  const { data, error } = await service.from("customers").insert({ garage_id: garageId, preferred_contact: "phone", channel: "sms", ...values }).select("id").single();
  if (error || !data) throw new Error(`Could not add a customer: ${error?.message}`);
  return data.id as string;
}

async function insertEnquiry(garageId: string, values: Record<string, unknown>) {
  const { data, error } = await service.from("enquiries").insert({ garage_id: garageId, type: "general", ...values }).select("id").single();
  if (error || !data) throw new Error(`Could not add an enquiry: ${error?.message}`);
  return data.id as string;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "ap");
  otherGarage = await createLocalGarage(service, "aq");
  for (const id of [garage.id, otherGarage.id]) {
    const { error } = await service.rpc("seed_garage_defaults", { p_garage_id: id });
    if (error) throw new Error(`Could not seed garage defaults: ${error.message}`);
  }
  const motOn = await service.from("garages").update({ mot_enabled: true }).eq("id", garage.id);
  if (motOn.error) throw new Error(`Could not switch MOT on: ${motOn.error.message}`);

  customerId = await insertCustomer(garage.id, { name: CUSTOMER.name, phone: CUSTOMER.phone, email: CUSTOMER.email, reminder_consent: true, consent_at: new Date().toISOString(), consent_source: "import" });
  const car = await service.from("vehicles").insert({ garage_id: garage.id, customer_id: customerId, registration: CUSTOMER.registration, make: "Honda", model: "Jazz" }).select("id").single();
  if (car.error || !car.data) throw new Error(`Could not add the car: ${car.error?.message}`);
  enquiryId = await insertEnquiry(garage.id, { customer_id: customerId, vehicle_id: car.data.id, description: "The brakes squeal when I stop." });
  const reply = await service.from("enquiry_messages").insert({
    garage_id: garage.id,
    enquiry_id: enquiryId,
    direction: "inbound",
    message_type: "email",
    sender_name: CUSTOMER.name,
    sender_email: CUSTOMER.email,
    subject: "Re: Your enquiry",
    text_body: "Friday morning would suit me.",
    delivery_status: "received",
    is_read: false,
  });
  if (reply.error) throw new Error(`Could not add the enquiry reply: ${reply.error.message}`);
  const trashedCustomer = await insertCustomer(garage.id, { name: "Tom Trashed", phone: "+447700900479" });
  trashedEnquiryId = await insertEnquiry(garage.id, { customer_id: trashedCustomer, description: "Please ignore.", deleted_at: new Date().toISOString() });
  const otherCustomer = await insertCustomer(otherGarage.id, { name: "Olive Elsewhere", phone: "+447700900480" });
  otherEnquiryId = await insertEnquiry(otherGarage.id, { customer_id: otherCustomer, description: "Another garage's enquiry." });

  owner = await createTotpMember(service, garage.id, "owner", "admin-pages-owner");
  // A second owner with an AAL2 token writes the draft invoice through the same RPC as the invoice form.
  writer = await createLocalMfaIdentity(service, config.publishableKey, `admin-pages-writer-${localRunId}@example.test`);
  const membership = await service.from("garage_members").insert({ garage_id: garage.id, user_id: writer.id, role: "owner" });
  if (membership.error) throw new Error(`Could not add the invoice writer: ${membership.error.message}`);
  const draft = await createLocalClient(config.publishableKey, writer.accessToken, garage.id).rpc("save_invoice_draft", {
    p_invoice_id: null,
    p_payload: { ...invoiceDraftPayload(londonDate(), localRunId), customer_id: customerId, customer_name: CUSTOMER.name, customer_email: CUSTOMER.email },
    p_confirm_duplicate_source: false,
  });
  if (draft.error || !draft.data) throw new Error(`Could not save the draft invoice: ${draft.error?.message}`);
  invoiceId = String(draft.data);

  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  for (const id of [garage?.id, otherGarage?.id]) if (id) await service.from("garages").delete().eq("id", id);
  for (const user of [owner, writer]) if (user) await service.auth.admin.deleteUser(user.id);
});

test("an owner signs in with password and TOTP", async () => {
  test.setTimeout(90_000);
  await signInWithTotp(page, adminOrigin, owner);
  await expect(page.locator("h1:visible")).toHaveCount(1);
});

test("every page the shell links to answers and passes axe at 390 and 1440", async () => {
  test.setTimeout(300_000);
  await page.goto(`${adminOrigin}/app`);
  const desktop = await shellLinks(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await shellLinks(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const found = [...new Set([...desktop, ...phone])];
  expect(found.filter((path) => SHELL_PAGES.includes(path)).sort(), "the shell links to every known page").toEqual([...SHELL_PAGES].sort());

  for (const path of found) {
    const response = await page.goto(`${adminOrigin}${path}`);
    const status = response?.status();
    if (NOT_BUILT_YET.has(path)) expect([200, 404], `status of ${path}`).toContain(status);
    else {
      expect(status, `status of ${path}`).toBe(200);
      // The admin's notFound() is a soft 404 (status 200, A189), so look for its page too.
      await expect(page.getByRole("heading", { level: 1, name: "Not found" }), `${path} is not the admin's not-found page`).toHaveCount(0);
    }
    expect(new URL(page.url()).pathname, `${path} kept the owner signed in`).not.toMatch(/^\/app\/(login|mfa)/);
    await expectAccessibleAt(page);
  }
});

test("customers: the list, a search by registration (never in the URL), the customer's page and the import page", async () => {
  await page.goto(`${adminOrigin}/app/customers`);
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  await expect(page.getByRole("link", { name: CUSTOMER.name }).first()).toBeVisible();

  await page.getByLabel("Search customers").fill(CUSTOMER.registration.toLowerCase());
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: CUSTOMER.name }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Tom Trashed" })).toHaveCount(0);
  expect(page.url().toUpperCase()).not.toContain(CUSTOMER.registration);
  await expectAccessibleAt(page);

  await page.getByRole("link", { name: CUSTOMER.name }).first().click();
  await expect(page).toHaveURL(`${adminOrigin}/app/customers/${customerId}`);
  await expect(page.getByRole("heading", { level: 1, name: CUSTOMER.name })).toBeVisible();
  await expect(page.getByText("Honda Jazz").first()).toBeVisible();
  await expectAccessibleAt(page);

  await page.goto(`${adminOrigin}/app/customers/import`);
  await expect(page.getByRole("heading", { level: 1, name: "Import customers" })).toBeVisible();
  await expectAccessibleAt(page);
});

test("enquiries: the inbox opens the thread; another garage's, a trashed and a missing enquiry show nothing", async () => {
  await page.goto(`${adminOrigin}/app/enquiries`);
  await expect(page.getByRole("heading", { level: 1, name: "Enquiries" })).toBeVisible();
  await expect(page.getByText("Friday morning would suit me.").first()).toBeVisible();
  await expect(page.getByText("Tom Trashed")).toHaveCount(0);
  await expect(page.getByText("Olive Elsewhere")).toHaveCount(0);
  await page.getByRole("link", { name: `Open enquiry from ${CUSTOMER.name}` }).click();
  await expect(page).toHaveURL(`${adminOrigin}/app/enquiries/${enquiryId}`);
  await expect(page.getByRole("heading", { level: 1, name: CUSTOMER.name })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
  await expect(page.getByText("The brakes squeal when I stop.")).toBeVisible();
  await expect(page.getByText("Friday morning would suit me.")).toBeVisible();
  await expectAccessibleAt(page);

  // On a phone the whole card opens the thread.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${adminOrigin}/app/enquiries`);
  await page.locator(`a[href="/app/enquiries/${enquiryId}"]:visible`).first().click();
  await expect(page).toHaveURL(`${adminOrigin}/app/enquiries/${enquiryId}`);
  await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The admin streams behind (protected)/loading.tsx, so Next sends notFound() with status 200 and a noindex
  // meta tag (as SOB's spec checked); what matters is that nothing of the enquiry is shown.
  for (const id of [otherEnquiryId, trashedEnquiryId, "00000000-0000-4000-8000-000000000000"]) {
    await page.goto(`${adminOrigin}/app/enquiries/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Conversation" })).toHaveCount(0);
    await expect(page.getByText(/Olive Elsewhere|Tom Trashed|Another garage's enquiry|Please ignore/)).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  }
  await expectAccessibleAt(page);
});

test("quotes and invoices: the list, a new invoice and the draft with its edit page", async () => {
  await page.goto(`${adminOrigin}/app/invoices/new`);
  await expectAccessibleAt(page);

  await page.goto(`${adminOrigin}/app/invoices`);
  const draft = page.getByRole("row").filter({ hasText: CUSTOMER.name });
  await expect(draft).toContainText("Draft");
  await draft.getByRole("link", { name: /^View/ }).click();
  await expect(page).toHaveURL(`${adminOrigin}/app/invoices/${invoiceId}`);
  await expect(page.getByText(CUSTOMER.name).first()).toBeVisible();
  await expectAccessibleAt(page);

  const response = await page.goto(`${adminOrigin}/app/invoices/${invoiceId}/edit`);
  expect(response?.status()).toBe(200);
  await expect(page.locator(`input[value="${CUSTOMER.name}"]`).first()).toBeVisible();
  await expectAccessibleAt(page);
});

test("trash lists the deleted enquiry", async () => {
  await page.goto(`${adminOrigin}/app/trash`);
  await expect(page.getByText("Tom Trashed")).toBeVisible();
  await expect(page.getByText(CUSTOMER.name)).toHaveCount(0);
});
