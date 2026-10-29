/**
 * Booking page & domain settings (P4.3) and the Askbridge chat setting (P4.6) at /app/settings/booking-page,
 * under playwright.garage.config.ts (project `booking-page-settings`) against the production build and local
 * Supabase. Domains use the in-memory mock Vercel client (VERCEL_DOMAINS_MODE unset).
 *
 * The spec makes its own garage, an owner and a manager (verified TOTP), and removes them afterwards.
 * Checks: free link + QR download, connect a custom domain (DNS table, status steps, Check now and its
 * 5-minute throttle, remove), the embed sites → the garage host's CSP frame-ancestors (no X-Frame-Options)
 * while the admin host stays SAMEORIGIN, the chat setting (Askbridge site key; the loader and its API are
 * answered by the test, never the real Askbridge), the manager's read-only view, and axe with no
 * violations at 390 and 1440 with no horizontal scroll.
 */
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createTotpMember, signInWithTotp, type TotpMember } from "../helpers/admin-session";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, type LocalTestGarage } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const PATH = "/app/settings/booking-page";
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const hostname = `book.af${randomUUID().replace(/[^0-9a-e]/g, "").slice(0, 8)}motors.co.uk`;

test.describe.configure({ mode: "serial" });

let garage: LocalTestGarage;
let owner: TotpMember;
let manager: TotpMember;
let admin: BrowserContext;
let page: Page;
let siteOrigin: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  garage = await createLocalGarage(service, "bp");
  siteOrigin = `http://${garage.slug}.localhost:${port}`;
  const { error } = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (error) throw new Error(`Could not seed garage defaults: ${error.message}`);
  owner = await createTotpMember(service, garage.id, "owner", "page-owner");
  manager = await createTotpMember(service, garage.id, "manager", "page-manager");
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await admin.newPage();
  await signInWithTotp(page, adminOrigin, owner);
});

test.afterAll(async () => {
  await admin?.close();
  if (garage) {
    await service.from("jobs").delete().eq("garage_id", garage.id);
    await service.from("garages").delete().eq("id", garage.id);
  }
  for (const member of [owner, manager]) if (member) await service.auth.admin.deleteUser(member.id);
});

/** Response headers of a garage-host page, fetched by the browser (it maps *.localhost to loopback). */
async function siteHeaders(path = "/") {
  const visitor = await admin.newPage();
  const response = await visitor.goto(`${siteOrigin}${path}`);
  expect(response?.status()).toBe(200);
  const headers = (await response?.allHeaders()) ?? {};
  await visitor.waitForLoadState("load");
  await visitor.close();
  return headers;
}

async function expectAccessibleAt(target: Page, widths: number[] = [390, 1440]) {
  for (const width of widths) {
    await target.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(target).toHaveTitle(/\S/);
    await target.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    // As in settings.spec.ts: only while SOB's shell nests a <main> are its three landmark rules left out.
    const nestedMain = await target.evaluate(() => document.querySelectorAll("main main").length > 0);
    const axe = new AxeBuilder({ page: target });
    if (nestedMain) axe.disableRules(["landmark-main-is-top-level", "landmark-no-duplicate-main", "landmark-unique"]);
    const results = await axe.analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
  }
  await target.setViewportSize({ width: 1440, height: 1000 });
}

test("free link, QR code and the page at 390 and 1440", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await expect(page.getByRole("heading", { level: 1, name: "Booking page", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup pages" }).getByRole("link", { name: "Booking page" })).toHaveAttribute("aria-current", "page");
  const freeLink = page.locator("#free-link");
  // A production build shows the real free link (garageBaseUrl), whatever host serves the admin.
  const freeHost = `${garage.slug}.pitline.co.uk`;
  await expect(freeLink.locator("code")).toHaveText(freeHost);
  await expect(freeLink.getByRole("button", { name: /Copy/ })).toBeVisible();

  await freeLink.getByText("Show QR code").click();
  await expect(freeLink.getByRole("img", { name: `QR code for ${freeHost}` })).toBeVisible();
  const png = await page.request.get(`${adminOrigin}${PATH}/qr?format=png`);
  expect(png.status()).toBe(200);
  expect(png.headers()["content-type"]).toBe("image/png");
  expect(png.headers()["content-disposition"]).toContain(`${garage.slug}-booking-qr.png`);
  expect([...(await png.body()).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const svg = await page.request.get(`${adminOrigin}${PATH}/qr?format=svg`);
  expect(svg.headers()["content-type"]).toContain("image/svg+xml");

  await expectAccessibleAt(page);
});

test("connect a custom domain: DNS record, status steps, Check now and its throttle", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  const own = page.locator("#own-address");
  await own.getByLabel("Web address").fill("theirgarage.co.uk");
  await own.getByRole("button", { name: "Connect" }).click();
  await expect(own.getByLabel("Web address")).toBeFocused();
  await expect(own.getByRole("alert")).toBeVisible();

  await own.getByLabel("Web address").fill(hostname);
  await own.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL(/done=domain_connected/);
  await expect(page.getByRole("status").filter({ hasText: "Address added. Now add the record below" })).toBeVisible();
  const table = own.getByRole("region", { name: `DNS records for ${hostname}` });
  await expect(table.getByRole("row").nth(1)).toContainText("CNAME");
  await expect(table.getByRole("row").nth(1)).toContainText("book");
  await expect(table.getByRole("row").nth(1)).toContainText("cname.vercel-dns-0.com");
  await expect(own.getByRole("list", { name: "Connection progress" })).toHaveAttribute("data-status", "pending_dns");
  await expect(own.getByRole("link", { name: /Email these steps/ })).toHaveAttribute("href", /^mailto:\?subject=/);
  await expectAccessibleAt(page);

  await own.getByRole("button", { name: "Check now" }).click();
  await expect(own.getByText(/We found your record/)).toBeVisible();
  await page.reload();
  await expect(own.getByRole("list", { name: "Connection progress" })).toHaveAttribute("data-status", "verifying");
  await expect(own.getByText(/You can check again in 5 minutes/)).toBeVisible();
  await own.getByRole("button", { name: "Check now" }).click();
  await expect(own.getByRole("alert")).toContainText("We checked a moment ago");
});

test("embed sites become the garage host's frame-ancestors; the admin host stays same-origin", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  const website = page.locator("#website");
  await expect(website.getByRole("tab", { name: '"Book online" button' })).toHaveAttribute("aria-selected", "true");
  const field = website.getByLabel("Websites that may show your booking page");
  await field.fill("http://www.notsecure.co.uk");
  await website.getByRole("button", { name: "Save websites" }).click();
  await expect(field).toBeFocused();

  await field.fill("https://www.afmotors.co.uk\nshop.afmotors.co.uk");
  await website.getByRole("button", { name: "Save websites" }).click();
  await expect(website.getByText("Those 2 websites can now show your booking page.")).toBeVisible();

  for (const path of ["/", "/privacy"]) {
    const booking = await siteHeaders(path);
    expect(booking["content-security-policy"]).toContain("frame-ancestors 'self' https://www.afmotors.co.uk https://shop.afmotors.co.uk");
    expect(booking["x-frame-options"]).toBeUndefined();
  }

  const adminPage = await page.request.get(`${adminOrigin}/app/login`);
  expect(adminPage.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(adminPage.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
});

test("Askbridge chat: validated site key, on and off", async () => {
  const siteKey = "pk_0123456789abcdef0123456789abcdef";
  await page.goto(`${adminOrigin}${PATH}`);
  const chat = page.locator("#askbridge");
  // The steps name this garage's booking page address to add in Askbridge.
  await expect(chat.locator("code", { hasText: garage.slug }).first()).toBeVisible();
  await chat.getByLabel("Show the chat on my booking page").check();
  await chat.getByRole("button", { name: "Save chat" }).click();
  await expect(chat.getByLabel("Askbridge site key")).toBeFocused();

  await chat.getByLabel("Askbridge site key").fill("wid_e2e_garage");
  await chat.getByRole("button", { name: "Save chat" }).click();
  await expect(chat.getByText(/isn't an Askbridge site key/).first()).toBeVisible();
  await expect(chat.getByLabel("Askbridge site key")).toBeFocused();

  await chat.getByLabel("Askbridge site key").fill(siteKey);
  await chat.getByRole("button", { name: "Save chat" }).click();
  await expect(chat.getByText("Saved. The Askbridge chat is on for your booking page.")).toBeVisible();
  const { data } = await service.from("garages").select("settings").eq("id", garage.id).single();
  expect((data?.settings as { askbridge?: unknown }).askbridge).toEqual({ enabled: true, siteKey });
  const { data: jobs } = await service.from("jobs").select("kind").eq("garage_id", garage.id).eq("kind", "askbridge.sync");
  expect(jobs).toEqual([]);

  // The booking host loads Askbridge's loader with data-site and async, and its CSP lets it run and call its
  // API. The loader and the API are answered here, so the test never reaches the real Askbridge.
  const unavailable = await chat.getByText("The chat can't load on booking pages right now.").isVisible();
  if (!unavailable) {
    const visitor = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
    await visitor.route(
      (url) => /\/(askbridge|widget)\.js$/.test(url.pathname),
      (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: `(() => {
            const s = document.currentScript;
            const site = s.getAttribute("data-site");
            fetch(new URL(s.src).origin + "/api/v1/visitor/config?site=" + encodeURIComponent(site), { credentials: "omit" })
              .then((r) => r.json())
              .then((c) => { window.__askbridge = { site, ok: c.ok === true }; })
              .catch((e) => { window.__askbridge = { site, error: String(e) }; });
          })();`,
        }),
    );
    await visitor.route("**/api/v1/visitor/config?*", (route) =>
      route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"ok":true}' }),
    );
    const site = await visitor.newPage();
    const response = await site.goto(`${siteOrigin}/`);
    const script = site.locator("script#askbridge-widget");
    const src = await script.getAttribute("src", { timeout: 15_000 });
    expect(src).toBeTruthy();
    const csp = response?.headers()["content-security-policy"] ?? "";
    const sourcesOf = (name: string) => csp.split(";").map((part) => part.trim().split(/\s+/)).find(([directive]) => directive === name)?.slice(1) ?? [];
    const loaderOrigin = new URL(src!).origin;
    expect(sourcesOf("script-src")).toContain(loaderOrigin);
    expect(sourcesOf("connect-src")).toContain(loaderOrigin);
    expect(sourcesOf("frame-src")).not.toContain(loaderOrigin);
    await expect(script).toHaveAttribute("data-site", siteKey);
    expect(await script.evaluate((element) => (element as HTMLScriptElement).async)).toBe(true);
    expect(await script.evaluate((element) => element.getAttributeNames().filter((name) => name.startsWith("data-")).sort())).toEqual(["data-nscript", "data-site"]);
    await site.waitForFunction(() => (window as { __askbridge?: unknown }).__askbridge !== undefined, null, { timeout: 15_000 });
    expect(await site.evaluate(() => (window as { __askbridge?: unknown }).__askbridge)).toEqual({ site: siteKey, ok: true });
    await visitor.close();
  }

  await chat.getByLabel("Show the chat on my booking page").uncheck();
  await chat.getByRole("button", { name: "Save chat" }).click();
  await expect(chat.getByText("Saved. The Askbridge chat is off.")).toBeVisible();
  expect((await siteHeaders())["content-security-policy"]).not.toMatch(/askbridge|127\.0\.0\.1:4100/);
});

test("a manager sees the settings read only", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const managerPage = await context.newPage();
  await signInWithTotp(managerPage, adminOrigin, manager);
  await managerPage.goto(`${adminOrigin}${PATH}`);
  await expect(managerPage.getByText("Only the garage owner can change them.")).toBeVisible();
  await expect(managerPage.locator("#own-address").getByRole("button", { name: "Check now" })).toBeDisabled();
  await expect(managerPage.locator("#own-address").getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(managerPage.getByRole("button", { name: "Save websites" })).toBeDisabled();
  await expect(managerPage.getByRole("button", { name: "Save chat" })).toBeDisabled();
  await expectAccessibleAt(managerPage);
  await context.close();
});

test("the owner removes the custom domain", async () => {
  await page.goto(`${adminOrigin}${PATH}`);
  await page.locator("#own-address").getByRole("button", { name: `Remove ${hostname}` }).click();
  await page.waitForURL(/done=domain_removed/);
  await expect(page.getByText("Address removed. Customers use your free link again.")).toBeVisible();
  await expect(page.locator("#own-address").getByLabel("Web address")).toBeVisible();
  const { data } = await service.from("garage_domains").select("deleted_at").eq("garage_id", garage.id).eq("hostname", hostname).single();
  expect(data?.deleted_at).toBeTruthy();
});
