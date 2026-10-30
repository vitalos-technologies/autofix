/**
 * P5.10 accounting sync at /app/settings/accounting, under playwright.garage.config.ts (project `p5-accounting`)
 * against the production build and local Supabase, with ACCOUNTING_PROVIDER_MODE unset (the fake provider:
 * its "consent" sends the browser straight back to our callback).
 *
 * The spec makes its own garage (new garages are on the Pro trial), an owner and a manager with verified TOTP,
 * and removes them afterwards. Journey: the three providers; Connect Xero (state cookie, PKCE, callback);
 * choose the organisation; invoices issued and a payment recorded (through issue_invoice() and
 * record_invoice_payment() as the owner) are queued by the triggers; Sync now; one invoice fails and Retry
 * sends it; a refused connection shows the reconnect banner and Reconnect fixes it; the manager sees status
 * but cannot connect; Disconnect (tokens deleted, history kept); an Essentials garage gets the locked page and
 * the connect route answers 403 PLAN_REQUIRED. Axe at 390 and 1440 on every screen, screenshots for
 * docs/autofix/screenshots/phase-5.
 */
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { PLAYWRIGHT_CRON_SECRET } from "../helpers/jobs";
import { createLocalClient, createLocalGarage, executeLocalOwnerSql, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const PATH = "/app/settings/accounting";
const SHOTS = "docs/autofix/screenshots/phase-5";
const service = createLocalClient(getLocalSupabaseConfig().secretKey);

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let owner: TotpMember;
let manager: TotpMember;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  garage = await createLocalGarage(service, "ac");
  owner = await createTotpMember(service, garage.id, "owner", "acct-owner");
  manager = await createTotpMember(service, garage.id, "manager", "acct-manager");
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await signInWithTotp(page, adminOrigin, owner);
});

test.afterAll(async () => {
  await context?.close();
  if (garage) await service.from("garages").delete().eq("id", garage.id);
  for (const member of [owner, manager]) if (member) await service.auth.admin.deleteUser(member.id);
});

async function expectAccessibleAt(target: Page, shot: string) {
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    // A server action's after() drain can refresh the page; axe waits until the page itself (its h1) is back,
    // not the admin loading skeleton that streams in meanwhile.
    await target.waitForLoadState("networkidle");
    await expect(target.getByRole("heading", { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
    await target.screenshot({ path: `${SHOTS}/accounting-${shot}-${width}.png`, fullPage: true });
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

/** Issues an invoice as the owner (issue_invoice() through psql with the owner's claims), optionally recording a payment. */
function issueInvoice(customerName: string, options: { pay?: number } = {}): string {
  const invoiceId = randomUUID();
  executeLocalOwnerSql(
    `begin;
insert into public.invoices (id, garage_id, status, source_type, customer_name, customer_email, created_by, updated_by)
values (:'invoice', :'garage', 'draft', 'manual', :'customer', 'accounts@example.test', :'owner', :'owner');
insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence)
values (:'garage', :'invoice', 'Brake pads and labour', 1, 18000, 0);
select set_config('request.jwt.claims', jsonb_build_object('sub', :'owner', 'role', 'authenticated', 'aal', 'aal2')::text, true),
       set_config('request.headers', jsonb_build_object('x-garage-id', :'garage')::text, true);
set local role authenticated;
select public.issue_invoice(:'invoice');
${options.pay ? `select public.record_invoice_payment(:'invoice', ${options.pay}, now(), 'card', 'Card');` : ""}
commit;`,
    { invoice: invoiceId, garage: garage.id, customer: customerName, owner: owner.id },
  );
  return invoiceId;
}

async function items() {
  const { data, error } = await service.from("accounting_sync_items").select("entity,local_id,status,last_error_code,remote_id").eq("garage_id", garage.id);
  if (error) throw error;
  return data as { entity: string; local_id: string; status: string; last_error_code: string | null; remote_id: string | null }[];
}

async function connection() {
  const { data } = await service.from("accounting_connections").select("id,provider,status,tenant_id,tenant_name").eq("garage_id", garage.id).neq("status", "disconnected").maybeSingle();
  return data as { id: string; provider: string; status: string; tenant_id: string | null; tenant_name: string | null } | null;
}

test("the owner sees the three providers", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.getByRole("heading", { level: 1, name: "Accounting" })).toBeVisible();
  for (const name of ["Xero", "QuickBooks", "Sage Accounting"]) await expect(page.getByRole("button", { name: `Connect ${name}` })).toBeEnabled();
  await expect(page.getByText(/Test mode: connections use Pitline's built-in test accounts/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Accounting/ }).first()).toHaveAttribute("href", PATH);
  await expectAccessibleAt(page, "connect");
});

test("Connect Xero runs the OAuth round trip and asks which organisation", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await page.getByRole("button", { name: "Connect Xero" }).click();
  await expect(page).toHaveURL(new RegExp(`${PATH}\\?choose=1$`));
  // The code and state never stay in the address bar; the state cookie is gone after the callback.
  expect((await context.cookies()).some((cookie) => cookie.name === "af_accounting_oauth")).toBe(false);
  await expect(page.getByRole("group", { name: "Which organisation should Pitline use?" })).toBeVisible();
  expect((await connection())?.status).toBe("pending");
  const { count } = await service.from("accounting_connection_secrets").select("connection_id", { count: "exact", head: true }).eq("garage_id", garage.id);
  expect(count).toBe(1);
  const { data: secret } = await service.from("accounting_connection_secrets").select("access_token_ct").eq("garage_id", garage.id).single();
  expect(String(secret?.access_token_ct)).toMatch(/^v1\./);
  expect(String(secret?.access_token_ct)).not.toContain("fake-access");
  await expectAccessibleAt(page, "choose");
  await page.getByLabel("Second Company Ltd (test)").check();
  await page.getByRole("button", { name: "Use this organisation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected." })).toBeVisible();
  expect(await connection()).toMatchObject({ provider: "xero", status: "connected", tenant_id: "fake-org-2", tenant_name: "Second Company Ltd (test)" });
});

test("a callback with a forged state is refused", async () => {
  await page.goto(`${adminOrigin}/api/admin/accounting/xero/callback?code=fake.x&state=forged`);
  await expect(page).toHaveURL(new RegExp(`${PATH}\\?error=connect_state$`));
  await expect(page.getByRole("alert").filter({ hasText: "couldn't match that sign-in" })).toBeVisible();
});

test("issued invoices and payments sync; a failed one is retried", async () => {
  const good = issueInvoice("Jo Bloggs", { pay: 5000 });
  expect((await items()).filter((item) => item.status === "pending").map((item) => item.entity).sort()).toEqual(["invoice", "payment"]);

  await page.goto(`${adminOrigin}${PATH}`);
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Syncing now." })).toBeVisible();
  await expect.poll(async () => (await items()).find((item) => item.entity === "invoice" && item.local_id === good)?.status, { timeout: 60_000 }).toBe("synced");
  await expect.poll(async () => (await items()).find((item) => item.entity === "payment")?.status, { timeout: 60_000 }).toBe("synced");

  // The fake refuses the first invoice for "Fail Once" customers (VALIDATION): drained by the runner like the cron does.
  const failing = issueInvoice("Fail Once Motors");
  const drained = await page.request.post(`${adminOrigin}/api/jobs/drain`, { headers: { authorization: `Bearer ${PLAYWRIGHT_CRON_SECRET}` }, data: { kinds: ["accounting.sync"] } });
  expect(drained.status()).toBe(200);
  await expect.poll(async () => (await items()).find((item) => item.entity === "invoice" && item.local_id === failing)?.status, { timeout: 60_000 }).toBe("failed");

  await page.reload();
  const attention = page.locator("#failed");
  await expect(attention.getByText(/Refused: check the account codes/)).toBeVisible();
  await expect(page.locator("#status").getByText(/^Payment £50\.00 on /)).toBeVisible();
  await expectAccessibleAt(page, "status");
  await attention.getByRole("button", { name: /^Retry Invoice/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Trying that one again now." })).toBeVisible();
  await expect.poll(async () => (await items()).find((item) => item.entity === "invoice" && item.local_id === failing)?.status, { timeout: 60_000 }).toBe("synced");
  await page.reload();
  await expect(page.locator("#failed").getByText("Nothing has failed.")).toBeVisible();
});

test("a manager sees the status and can sync, but cannot connect or disconnect", async ({ browser }) => {
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const managerPage = await managerContext.newPage();
  await signInWithTotp(managerPage, adminOrigin, manager);
  await managerPage.goto(`${adminOrigin}${PATH}`);
  await expect(managerPage.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(managerPage.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  const refused = await managerPage.request.post(`${adminOrigin}/api/admin/accounting/xero/connect`, { headers: { Origin: adminOrigin }, maxRedirects: 0 });
  expect(refused.status()).toBe(303);
  expect(refused.headers().location).toContain("error=owner_only");
  await managerContext.close();
});

test("when the provider refuses the connection the banner asks for a reconnect, and Reconnect fixes it", async () => {
  issueInvoice("Auth Expired Ltd");
  await page.goto(`${adminOrigin}${PATH}`);
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(async () => (await connection())?.status, { timeout: 60_000 }).toBe("needs_reconnect");
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.locator("#reconnect-banner")).toContainText("stopped accepting our connection");
  await expectAccessibleAt(page, "reconnect");
  await page.getByRole("button", { name: "Reconnect Xero" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected." })).toBeVisible();
  expect(await connection()).toMatchObject({ status: "connected", tenant_id: "fake-org-2" });
});

test("Disconnect deletes the stored sign-in and keeps the history", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText(/We sign Pitline out of it and delete the stored sign-in/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, disconnect" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Disconnected." })).toBeVisible();
  expect(await connection()).toBeNull();
  const { count } = await service.from("accounting_connection_secrets").select("connection_id", { count: "exact", head: true }).eq("garage_id", garage.id);
  expect(count).toBe(0);
  expect((await items()).filter((item) => item.status === "synced").length).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("button", { name: "Connect Xero" })).toBeVisible();
});

test("an Essentials garage sees the locked page and the connect route answers 403 PLAN_REQUIRED", async () => {
  await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.getByText("Accounting sync is on Pro")).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect Xero/ })).toHaveCount(0);
  const refused = await page.request.post(`${adminOrigin}/api/admin/accounting/xero/connect`, { headers: { Origin: adminOrigin }, maxRedirects: 0 });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "PLAN_REQUIRED", feature: "accounting_sync" });
  await expectAccessibleAt(page, "locked");
});
