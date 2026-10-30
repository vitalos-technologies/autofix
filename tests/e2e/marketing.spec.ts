/**
 * The marketing page on the admin host (`/`). Needs no database, so it runs in the default config
 * (`pnpm test:e2e`, desktop and mobile projects).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Every axe rule at 390 and 1440, no horizontal scroll, one main. */
async function expectAccessibleAt(page: Page) {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    // The hero entrance runs once; the badge's pulse loops forever and is never awaited.
    await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
    await expect(page.locator("main")).toHaveCount(1);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
  }
}

test("/ is the Pitline marketing page, indexable, with no axe violations at 390 and 1440", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page).toHaveTitle("Pitline · Online booking for independent garages");
  await expect(page.getByRole("heading", { level: 1, name: "Your garage, fully booked." })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
  await expectAccessibleAt(page);
});

test("Log in opens the admin sign-in", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/app\/login$/);
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
});

test("the FAQs open and the mobile menu reaches every section", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const menu = page.getByRole("banner").locator("summary");
  await menu.click();
  const nav = page.getByRole("navigation", { name: "Menu" });
  await expect(nav.getByRole("link", { name: "Set up your garage" })).toHaveAttribute("href", "/signup");
  await nav.getByRole("link", { name: "FAQs" }).click();
  await expect(page).toHaveURL(/#faqs$/);

  const question = page.getByText("Can two customers book the same slot?");
  await question.click();
  await expect(page.getByText("so the same bay can't be booked twice")).toBeVisible();
});

test("robots.txt lets crawlers see / and nothing else", async ({ request }) => {
  const body = await (await request.get("/robots.txt")).text();
  expect(body).toContain("Allow: /$");
  expect(body).toContain("Disallow: /");
});
