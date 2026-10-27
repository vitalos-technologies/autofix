import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "3000";
const host = process.env.PLAYWRIGHT_HOST || "127.0.0.1";
const baseURL = `http://${host}:${port}`;
// Use a preinstalled Chromium (for example in sandboxes without a Playwright download).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  // Garage-host specs need local Supabase and the seed: playwright.garage.config.ts
  // (`pnpm test:e2e:smoke`, `pnpm test:e2e:booking`).
  testIgnore: ["smoke.spec.ts", "booking.spec.ts"],
  fullyParallel: true,
  workers: process.env.E2E_ADMIN_ENQUIRY_IDS ? 1 : 2,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL,
    trace: "on-first-retry",
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      PLAYWRIGHT_TEST: "true",
      VEHICLE_LOOKUP_PROVIDER: "mock",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"], browserName: "chromium" } },
  ],
});
