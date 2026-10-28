/**
 * P5.3 digital health checks, end to end (project `p5-health-checks`, `pnpm test:e2e:p5-health-checks`), against
 * the production build, local Supabase and the mock messaging channel.
 *
 * The spec makes its own garage (Pro trial, MOT on, `seed_garage_defaults()`, a messaging number), an owner with a
 * verified TOTP factor and one booking in the workshop today, and deletes all of it afterwards. In order:
 *   1. the owner starts the health check from the booking, rates three lines (red with a photo and priced work,
 *      amber with priced work, green), adds a video of the whole car and sends it (mock SMS): the outbound
 *      `messages` row is on the booking and its body never holds the link token;
 *   2. the customer opens a link on the garage host (`/hc/<token>`; the spec sets a token it knows, as the real one
 *      went to the mock outbox inside the server): a 303 to `/health-check` with no token and no registration in
 *      any URL; they approve the tyres, decline the pads and confirm (a second confirm changes nothing);
 *   3. the owner sees "Customer approved £160.00" on the check, the booking and Today, and adds the work to a
 *      draft invoice (save_invoice_draft()): one line at £160.00, no VAT;
 *   4. the garage moves to Essentials: the Health checks page is the Pro card with the check still listed, the
 *      check is read-only and starting a new one is refused.
 * axe runs with every rule at 390 and 1440 on every new screen, and each is saved to
 * docs/autofix/screenshots/phase-5/health-checks-<screen>-<390|1440>.png.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTodayBooking, createTotpMember, signInWithTotp, type TodayFixture, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const SHOTS = "docs/autofix/screenshots/phase-5";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
/** A few bytes declared as MP4: storage checks the declared type and size; the player just shows its frame. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12)]);

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let siteOrigin: string;
let owner: TotpMember;
let booking: TodayFixture;
let admin: BrowserContext;
let staff: Page;
let customer: BrowserContext;
let site: Page;
let checkId: string;
let token: string;
const urls: string[] = [];

function watch(context: BrowserContext) {
  context.on("request", (request) => urls.push(request.url()));
  context.on("page", (page) => page.on("framenavigated", (frame) => urls.push(frame.url())));
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

/** Every rule, at 390 and 1440: one <main>, no violations, no horizontal scroll; a full-page screenshot of each. */
async function checkScreen(target: Page, screen: string) {
  const path = new URL(target.url()).pathname;
  const own = target.viewportSize();
  mkdirSync(SHOTS, { recursive: true });
  for (const width of [390, 1440]) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    await expect(target.locator("main")).toHaveCount(1);
    const results = await new AxeBuilder({ page: target }).analyze();
    expect(results.violations, `axe at ${width}px on ${path}`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px on ${path}` }).toBeLessThanOrEqual(1);
    await target.screenshot({ path: `${SHOTS}/health-checks-${screen}-${width}.png`, fullPage: true });
  }
  if (own) await target.setViewportSize(own);
}

/** Opens a checklist line, rates it and saves it. */
async function rateLine(label: string, rating: "Red" | "Amber" | "Green", fields: { note?: string; work?: string; price?: string } = {}) {
  const line = staff.getByTestId("hc-item").filter({ has: staff.getByText(label, { exact: true }) });
  await line.locator("summary").click();
  await line.getByText(rating, { exact: true }).click();
  if (fields.note) await line.getByLabel("Note").fill(fields.note);
  if (fields.work) await line.getByLabel("Recommended work (optional)").fill(fields.work);
  if (fields.price) await line.getByLabel("Price").fill(fields.price);
  await line.getByRole("button", { name: `Save ${label}` }).click();
  await expect(line.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  return line;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "hc");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const motOn = await service.from("garages").update({ mot_enabled: true }).eq("id", garage.id);
  if (motOn.error) throw new Error(`Could not switch MOT on: ${motOn.error.message}`);
  const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (defaults.error) throw new Error(`Could not seed the garage: ${defaults.error.message}`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const number = `+4477009${String(randomBytes(2).readUInt16BE(0) % 100000).padStart(5, "0")}`;
    const added = await service.from("garage_phone_numbers").insert({ garage_id: garage.id, number, purpose: "messaging", provider_sid: `PNe2ehc${randomBytes(12).toString("hex")}` });
    if (!added.error) break;
    if (added.error.code !== "23505") throw new Error(`Could not add a messaging number: ${added.error.message}`);
  }
  booking = await createTodayBooking(
    { id: garage.id, slug: garage.slug, name: garage.name, bookingPrefix: garage.bookingPrefix, timezone: "Europe/London", cutoffHours: 24 },
    { service: "Full service", minutes: 8 * 60, status: "in_progress", customerName: "Holly Check", make: "Ford", model: "Fiesta" },
  );
  owner = await createTotpMember(service, garage.id, "owner", "hc-owner");
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  staff = await admin.newPage();
  customer = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.153" } });
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

test("the owner starts a health check from the booking, rates lines with photos and video, and sends it", async () => {
  test.setTimeout(180_000);
  await signInWithTotp(staff, adminOrigin, owner);
  await staff.goto(`${adminOrigin}/app/health-checks`);
  await expect(staff.getByRole("heading", { level: 1, name: "Health checks" }).first()).toBeVisible();
  await expect(staff.getByText("No health checks yet")).toBeVisible();
  await checkScreen(staff, "empty");

  await staff.goto(`${adminOrigin}/app/bookings/${booking.id}`);
  await staff.getByRole("button", { name: "Start health check" }).click();
  await expect(staff).toHaveURL(/\/app\/health-checks\/[0-9a-f-]{36}$/);
  checkId = staff.url().split("/").pop()!;
  await expect(staff.getByTestId("hc-item")).toHaveCount(25);
  await expect(staff.getByRole("heading", { name: "MOT items" })).toBeVisible();

  const tyre = await rateLine("Front left tyre", "Red", { note: "Worn to 1.6 mm on the inner edge.", work: "Two front tyres", price: "160" });
  await rateLine("Front brake pads and discs", "Amber", { work: "Front brake pads", price: "89.50" });
  await rateLine("Headlights and sidelights", "Green");
  await staff.reload();

  // A photo of the tyre, straight to storage on a signed upload URL.
  const reopened = staff.getByTestId("hc-item").filter({ has: staff.getByText("Front left tyre", { exact: true }) });
  await reopened.locator("summary").click();
  await reopened.locator('input[type="file"][accept^="image"]').setInputFiles({ name: "tyre.png", mimeType: "image/png", buffer: PNG });
  await expect(reopened.getByRole("img", { name: "Photo 1 of Front left tyre" })).toBeVisible({ timeout: 20_000 });
  await expect(tyre.getByRole("button", { name: /Remove photo 1/ })).toBeVisible();
  // A video of the whole car.
  await staff.locator("#summary").locator('input[type="file"][accept^="video"]').setInputFiles({ name: "walkround.mp4", mimeType: "video/mp4", buffer: MP4 });
  await expect(staff.locator("#summary video")).toHaveCount(1, { timeout: 20_000 });
  const stored = await service.from("health_check_media").select("object_path,uploaded").eq("check_id", checkId);
  expect(stored.data).toHaveLength(2);
  for (const row of stored.data ?? []) {
    expect(row.uploaded).toBe(true);
    expect(row.object_path).toMatch(new RegExp(`^${garage.id}/health-checks/${checkId}/[0-9a-f-]{36}\\.(png|mp4)$`));
  }
  // The bucket is private: no public URL serves the file.
  const publicUrl = `${getLocalSupabaseConfig().url}/storage/v1/object/public/health-check-media/${stored.data![0]!.object_path}`;
  expect((await staff.request.get(publicUrl)).ok()).toBe(false);

  await staff.getByRole("button", { name: "Send to customer" }).click();
  await expect(staff.getByRole("status").filter({ hasText: "Messaging is in test mode" })).toBeVisible();
  const sent = await service.from("messages").select("body,status,channel").eq("garage_id", garage.id).eq("booking_id", booking.id).eq("direction", "outbound");
  expect(sent.data?.some((row) => row.body?.includes("/hc/…") && row.status === "sent")).toBe(true);
  expect(sent.data?.every((row) => !/\/hc\/[A-Za-z0-9_-]{22}/.test(row.body ?? ""))).toBe(true);
  await expect(staff.getByText("Sent to customer").first()).toBeVisible();
  await staff.locator("details[open]").evaluateAll((open) => open.forEach((element) => element.removeAttribute("open")));
  await checkScreen(staff, "editor");
});

test("the customer opens the link, sees the check and approves the tyres only", async () => {
  test.setTimeout(120_000);
  // The real token went to the mock outbox inside the server; give the check one this spec knows.
  token = randomBytes(16).toString("base64url");
  const updated = await service.from("health_checks").update({ token_hash: createHash("sha256").update(token).digest("hex") }).eq("id", checkId);
  expect(updated.error).toBeNull();

  const response = await site.request.get(`${siteOrigin}/hc/${token}`, { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/health-check");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");

  await site.goto(`${siteOrigin}/hc/${token}`);
  await expect(site).toHaveURL(`${siteOrigin}/health-check`);
  await expect(site.getByRole("heading", { level: 1, name: "Your car's health check" })).toBeVisible();
  await expect(site.getByText("Needs attention now")).toBeVisible();
  await expect(site.getByRole("img", { name: "Photo 1 of Front left tyre" })).toBeVisible();
  await expect(site.getByTestId("hc-decision")).toHaveCount(2);
  await checkScreen(site, "customer");

  const tyres = site.getByTestId("hc-decision").filter({ hasText: "Two front tyres" });
  const pads = site.getByTestId("hc-decision").filter({ hasText: "Front brake pads" });
  await tyres.getByText("Approve", { exact: true }).click();
  await pads.getByText("Decline", { exact: true }).click();
  await expect(site.getByTestId("hc-customer-total")).toHaveText("£160.00");
  await site.getByRole("button", { name: "Confirm and approve £160.00" }).click();
  await expect(site.getByRole("status").filter({ hasText: "Thanks, your answer is with the garage" })).toBeVisible();
  await expect(site).toHaveURL(`${siteOrigin}/health-check?done=1`);
  await expect(site.getByText("You approved", { exact: true }).first()).toBeVisible();
  await checkScreen(site, "customer-answered");

  // Idempotent: confirming again (a replayed form) changes nothing.
  const replay = await service.rpc("record_health_check_decisions", { p_garage_id: garage.id, p_check_id: checkId, p_decisions: [] });
  expect((replay.data as { status: string }).status).toBe("already");

  const registration = compact(booking.registration);
  expect(urls.filter((url) => compact(url).includes(registration))).toEqual([]);
  expect(urls.filter((url) => url.includes(token) && !url.endsWith(`/hc/${token}`))).toEqual([]);
});

test("the owner sees the approval on the check, the booking and Today, and invoices it", async () => {
  test.setTimeout(120_000);
  await staff.goto(`${adminOrigin}/app/health-checks/${checkId}`);
  await expect(staff.getByTestId("hc-approved-total")).toHaveText("Customer approved £160.00");
  await checkScreen(staff, "answered");

  await staff.goto(`${adminOrigin}/app/bookings/${booking.id}`);
  await expect(staff.getByTestId("booking-health-check")).toHaveText("Customer approved £160.00");
  await expect(staff.getByText(/the customer approved £160\.00 of extra work: Two front tyres/)).toBeVisible();
  await staff.goto(`${adminOrigin}/app`);
  await expect(staff.locator("#hc-approvals")).toContainText("Customer approved £160.00");

  await staff.goto(`${adminOrigin}/app/health-checks`);
  await expect(staff.getByRole("link", { name: /Holly Check/ })).toContainText("Customer approved £160.00");
  await checkScreen(staff, "list");

  await staff.goto(`${adminOrigin}/app/health-checks/${checkId}`);
  await staff.getByRole("button", { name: "Add approved work to the invoice" }).click();
  await expect(staff).toHaveURL(/\/app\/invoices\/[0-9a-f-]{36}\?notice=saved$/);
  const invoiceId = new URL(staff.url()).pathname.split("/").pop()!;
  const invoice = await service.from("invoices").select("status,total_pence,tax_pence,booking_id").eq("id", invoiceId).single();
  expect(invoice.data).toEqual({ status: "draft", total_pence: 16000, tax_pence: 0, booking_id: booking.id });
  const lines = await service.from("invoice_items").select("description,line_total_pence").eq("invoice_id", invoiceId);
  expect(lines.data).toEqual([{ description: "Health check: Two front tyres (Front left tyre)", line_total_pence: 16000 }]);
  await staff.goto(`${adminOrigin}/app/health-checks/${checkId}`);
  await expect(staff.getByRole("link", { name: "Open the draft invoice" })).toBeVisible();
});

test("on Essentials the page is the Pro card, the check stays readable and new checks are refused", async () => {
  test.setTimeout(120_000);
  const downgraded = await service.from("garages").update({ plan: "essentials", trial_ends_at: null, plan_chosen: "essentials" }).eq("id", garage.id);
  expect(downgraded.error).toBeNull();

  await staff.goto(`${adminOrigin}/app/health-checks`);
  await expect(staff.getByRole("heading", { name: /Digital health checks is on Pro/ })).toBeVisible();
  await expect(staff.getByRole("link", { name: /Holly Check/ })).toBeVisible();
  await checkScreen(staff, "locked");

  await staff.goto(`${adminOrigin}/app/health-checks/${checkId}`);
  await expect(staff.getByRole("heading", { name: /Digital health checks is on Pro/ })).toBeVisible();
  await expect(staff.getByRole("button", { name: /^Save / })).toHaveCount(0);
  await expect(staff.getByRole("button", { name: "Send to customer" })).toHaveCount(0);

  await staff.goto(`${adminOrigin}/app/bookings/${booking.id}`);
  await expect(staff.getByRole("button", { name: "Start health check" })).toHaveCount(0);
  const other = await createTodayBooking(
    { id: garage.id, slug: garage.slug, name: garage.name, bookingPrefix: garage.bookingPrefix, timezone: "Europe/London", cutoffHours: 24 },
    { service: "Full service", minutes: 14 * 60, status: "arrived", customerName: "Essie Later", make: "Kia", model: "Picanto" },
  );
  await staff.goto(`${adminOrigin}/app/bookings/${other.id}`);
  await expect(staff.getByRole("button", { name: "Start health check" })).toHaveCount(0);
  const refused = await service.rpc("claim_health_check_send", {
    p_garage_id: garage.id,
    p_check_id: checkId,
    p_member_id: owner.id,
    p_token_hash: "d".repeat(64),
    p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_body: "Your health check is ready",
    p_provider: "mock",
  });
  expect((refused.data as { reason: string }).reason).toBe("plan_required");

  // The customer's link still shows what they chose, read-only.
  await site.goto(`${siteOrigin}/health-check`);
  await expect(site.getByText("You approved", { exact: true }).first()).toBeVisible();
});
