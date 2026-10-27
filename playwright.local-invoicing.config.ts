import { defineConfig, devices } from "@playwright/test";
import { getLocalSupabaseConfig } from "./tests/helpers/local-supabase";

const supabase = getLocalSupabaseConfig();
// CI runners on one machine each get their own port (scripts/ci/supabase-isolate.sh).
const port = process.env.PLAYWRIGHT_INVOICE_PORT || "3100";
const baseURL = `http://127.0.0.1:${port}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./tests/integration",
  testMatch: "invoice-pdf.playwright.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
    launchOptions: { executablePath },
  },
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: supabase.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
      SUPABASE_SECRET_KEY: supabase.secretKey,
      PLAYWRIGHT_TEST: "true",
      PLAYWRIGHT_LOCAL_INVOICING: "true",
      VEHICLE_LOOKUP_PROVIDER: "mock",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
    },
  },
  projects: [{ name: "local-invoicing-chromium", use: { ...devices["Desktop Chrome"] } }],
});
