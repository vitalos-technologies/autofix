/**
 * Host-routing smoke (P1.11), run by playwright.smoke.config.ts against
 * `pnpm build && pnpm start` with local Supabase and `pnpm db:seed` data.
 *
 * Garage hosts use `<slug>.localhost`, which Chromium resolves to loopback;
 * hosts that need a real DNS name go through node:http with a Host header.
 */
import { request as httpRequest } from "node:http";
import { expect, test, type Page } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || "3430");
const origin = (host: string) => `http://${host}:${port}`;

// From scripts/seed-demo.mjs.
const HARTLEY = { slug: "hartley-road", name: "Hartley Road Motors", accent: "#155fba" };
const DEMO_B = { slug: "demo-b", name: "Demo Garage B", accent: "#0f766e" };

async function siteRoot(page: Page, slug: string) {
  const root = page.locator(`[data-garage="${slug}"]`);
  await expect(root).toBeVisible();
  return root;
}

async function accentOf(page: Page, slug: string) {
  const root = await siteRoot(page, slug);
  return root.evaluate((element) => getComputedStyle(element).getPropertyValue("--garage-accent").trim().toLowerCase());
}

/** GET through node:http so the Host header can name a host DNS cannot resolve. */
function getWithHost(host: string, path = "/") {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `${host}:${port}` } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`GET ${host}${path} timed out`)));
    outgoing.end();
  });
}

test("hartley-road.localhost serves Hartley Road Motors' booking page in its accent", async ({ page }) => {
  const response = await page.goto(`${origin(`${HARTLEY.slug}.localhost`)}/`);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(new RegExp(HARTLEY.name));
  await expect(page).not.toHaveTitle(new RegExp(DEMO_B.name));
  expect(await accentOf(page, HARTLEY.slug)).toBe(HARTLEY.accent);
});

test("demo-b.localhost serves Demo Garage B's booking page in its accent", async ({ page }) => {
  const response = await page.goto(`${origin(`${DEMO_B.slug}.localhost`)}/`);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(new RegExp(DEMO_B.name));
  await expect(page).not.toHaveTitle(new RegExp(HARTLEY.name));
  expect(await accentOf(page, DEMO_B.slug)).toBe(DEMO_B.accent);
});

test("an unknown garage slug gets the 404 page", async ({ page }) => {
  const response = await page.goto(`${origin("no-such-garage.localhost")}/`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator("[data-garage]")).toHaveCount(0);
});

test("an unknown custom host gets 404", async () => {
  const response = await getWithHost("book.unknown-garage.example");
  expect(response.status).toBe(404);
  expect(response.body).toContain("Page not found");
  expect(response.body).not.toContain(HARTLEY.name);
});

test("localhost/app/login renders the admin sign-in", async ({ page }) => {
  const response = await page.goto(`${origin("localhost")}/app/login`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("a garage host cannot reach the admin or another garage's site", async ({ page }) => {
  const admin = await page.goto(`${origin(`${HARTLEY.slug}.localhost`)}/app/login`);
  expect(admin?.status()).toBe(404);

  // The internal /_site route is only reachable through the proxy rewrite.
  const direct = await page.goto(`${origin("localhost")}/_site/00000000-0000-4000-8000-000000000000`);
  expect(direct?.status()).toBe(404);
  const nested = await page.goto(`${origin(`${HARTLEY.slug}.localhost`)}/_site/00000000-0000-4000-8000-000000000000`);
  expect(nested?.status()).toBe(404);
});

// DECISIONS A188: a Referrer-Policy from next.config.ts replaces the one a route handler sets, so the links that
// carry a token in their URL get theirs from next.config.ts too. Checked through the server, where the override
// happens (the handlers' unit tests cannot see it).
test("links that carry a token keep their own Referrer-Policy", async () => {
  const garageHost = `${HARTLEY.slug}.localhost`;
  const cases = [
    { host: garageHost, path: `/r/${"A".repeat(43)}`, status: 303, policy: "no-referrer" },
    { host: garageHost, path: "/manage/link?token=not-a-token", status: 303, policy: "no-referrer" },
    { host: garageHost, path: "/manage-booking?token=not-a-token", status: 308, policy: "no-referrer" },
    { host: "localhost", path: "/signup/invite/not-a-token", status: 303, policy: "no-referrer" },
    { host: "localhost", path: "/auth/confirm?token_hash=not-a-token&type=email&next=/signup/garage", status: 200, policy: "strict-origin" },
    // Every other response keeps the site-wide policy.
    { host: garageHost, path: "/", status: 200, policy: "strict-origin-when-cross-origin" },
    { host: "localhost", path: "/app/login", status: 200, policy: "strict-origin-when-cross-origin" },
  ];
  for (const item of cases) {
    const response = await getWithHost(item.host, item.path);
    expect({ path: item.path, status: response.status, policy: response.headers["referrer-policy"] }).toEqual({ path: item.path, status: item.status, policy: item.policy });
  }
});
