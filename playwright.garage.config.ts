import { defineConfig, devices } from "@playwright/test";
import { getLocalSupabaseConfig } from "./tests/helpers/local-supabase";

// Browser tests on garage hosts. Garage hosts resolve through the database, so
// these need local Supabase, the demo seed (`pnpm db:seed`) and a production
// build made with the same Supabase env exported (`pnpm build`; NEXT_PUBLIC_*
// values are inlined at build time).
//   pnpm test:e2e:smoke    smoke.spec.ts    host routing (garage hosts, unknown hosts, admin login)
//   pnpm test:e2e:booking  booking.spec.ts  the 5-step booking flow on http://hartley-road.localhost:<port>/
//                          on the real engine (create_booking() in local Supabase), desktop, Pixel 5 and 390x844
//   pnpm test:e2e:manage   manage.spec.ts   manage booking (/manage): lookup, signed link, move, cancel, at 390px
//   pnpm test:e2e:settings settings.spec.ts setup pages (/app/settings/*) for an owner signed in with password +
//                          TOTP, checked on its own garage's booking site (<slug>.localhost), axe at 390 and 1440
// Both run on the database engine (available_slots(), create_booking()): booking.spec.ts reads the rows it
// books back and the manage pages always read the database. The in-memory engine (BOOKING_ENGINE=fake,
// src/lib/booking-engine/fake.ts) is for UI work under `pnpm dev` only.
const supabase = getLocalSupabaseConfig();
const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const bookingOrigin = `http://hartley-road.localhost:${port}`;
// Use a preinstalled Chromium (for example in sandboxes without a Playwright download).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["smoke.spec.ts", "booking.spec.ts", "manage.spec.ts", "settings.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    trace: "retain-on-failure",
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      // Chromium resolves *.localhost to loopback itself; this keeps it so
      // where a resolver or proxy would interfere.
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    },
  },
  webServer: {
    command: `pnpm start --port ${port}`,
    url: `${adminOrigin}/app/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: port,
      NEXT_PUBLIC_SUPABASE_URL: supabase.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
      SUPABASE_SECRET_KEY: supabase.secretKey,
      NEXT_PUBLIC_SITE_URL: adminOrigin,
      DEV_TENANT_ROOT_DOMAIN: `localhost:${port}`,
      PLAYWRIGHT_TEST: "true",
      VEHICLE_LOOKUP_PROVIDER: "mock",
      // Gate 2 runs on the real engine, whatever the shell exports (see the header).
      BOOKING_ENGINE: "supabase",
      // Production builds refuse to seal the booking cookies or sign manage links without keys. CI generates its
      // own per job; these fallbacks are for local runs only and are not secrets.
      BOOKING_STATE_SECRET: process.env.BOOKING_STATE_SECRET || "playwright-local-booking-state-key-not-a-secret",
      // tests/helpers/booking-fixtures.ts derives link tokens with the same value.
      BOOKING_MANAGEMENT_SECRET: process.env.BOOKING_MANAGEMENT_SECRET || "playwright-local-booking-manage-key-not-a-secret",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
    },
  },
  projects: [
    { name: "smoke-chromium", testMatch: "smoke.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    { name: "booking-chromium", testMatch: "booking.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: bookingOrigin } },
    { name: "booking-mobile", testMatch: "booking.spec.ts", use: { ...devices["Pixel 5"], browserName: "chromium", baseURL: bookingOrigin } },
    // Phone first: 390 x 844 (the design's frame).
    {
      name: "booking-390",
      testMatch: "booking.spec.ts",
      use: { ...devices["Pixel 5"], browserName: "chromium", viewport: { width: 390, height: 844 }, baseURL: bookingOrigin },
    },
    // The manage spec also checks 1440 for horizontal scroll.
    {
      name: "manage-mobile",
      testMatch: "manage.spec.ts",
      use: { ...devices["Pixel 5"], browserName: "chromium", viewport: { width: 390, height: 844 }, baseURL: bookingOrigin },
    },
    // Setup pages: its own garage and signed-in owner; the spec checks 390 and 1440 itself.
    { name: "settings", testMatch: "settings.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
  ],
});
