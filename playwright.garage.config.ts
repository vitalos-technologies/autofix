import { defineConfig, devices } from "@playwright/test";
import { getLocalSupabaseConfig } from "./tests/helpers/local-supabase";

// Browser tests on garage hosts. Garage hosts resolve through the database, so
// these need local Supabase, the demo seed (`pnpm db:seed`) and a production
// build made with the same Supabase env exported (`pnpm build`; NEXT_PUBLIC_*
// values are inlined at build time).
//   pnpm test:e2e:smoke    smoke.spec.ts    host routing (garage hosts, unknown hosts, admin login)
//   pnpm test:e2e:booking  booking.spec.ts  the 5-step booking flow on http://hartley-road.localhost:<port>/
//                          (in-memory booking engine unless BOOKING_ENGINE is set to something else)
const supabase = getLocalSupabaseConfig();
const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const bookingOrigin = `http://hartley-road.localhost:${port}`;
// Use a preinstalled Chromium (for example in sandboxes without a Playwright download).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["smoke.spec.ts", "booking.spec.ts"],
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
      // The fake engine (src/lib/booking-engine/fake.ts) until the scheduling tables and repository land.
      BOOKING_ENGINE: process.env.BOOKING_ENGINE || "fake",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
    },
  },
  projects: [
    { name: "smoke-chromium", testMatch: "smoke.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    { name: "booking-chromium", testMatch: "booking.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: bookingOrigin } },
    { name: "booking-mobile", testMatch: "booking.spec.ts", use: { ...devices["Pixel 5"], browserName: "chromium", baseURL: bookingOrigin } },
  ],
});
