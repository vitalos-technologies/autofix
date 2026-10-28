import { defineConfig, devices } from "@playwright/test";
import { garageSpecs } from "./tests/e2e/garage-specs";
import { PLAYWRIGHT_CRON_SECRET } from "./tests/helpers/jobs";
import { getLocalSupabaseConfig } from "./tests/helpers/local-supabase";

// Browser tests on garage hosts. Garage hosts resolve through the database, so
// these need local Supabase, the demo seed (`pnpm db:seed`) and a production
// build made with the same Supabase env exported (`pnpm build`; NEXT_PUBLIC_*
// values are inlined at build time).
//   pnpm test:e2e:smoke    smoke.spec.ts    host routing (garage hosts, unknown hosts, admin login)
//   pnpm test:e2e:booking  booking.spec.ts  the 5-step booking flow on http://hartley-road.localhost:<port>/
//                          on the real engine (create_booking() in local Supabase), desktop, Pixel 5 and 390x844
//   pnpm test:e2e:manage   manage.spec.ts   manage booking (/manage): lookup, signed link, move, cancel, at 390px
//   pnpm test:e2e:admin    admin.spec.ts    garage admin on the admin host (P3.1-P3.3): sign-in with TOTP, Today,
//                          accept, status + notes, search, staff booking, diary, garage switch; 1440 and 390x844
//                          admin-pages.spec.ts (also in test:e2e:admin): every page the shell links to, with axe at
//                          390 and 1440, and the Customers, Enquiries, Invoices and Trash journeys
//   pnpm test:e2e:settings settings.spec.ts setup pages (/app/settings/*) for an owner signed in with password +
//                          TOTP, checked on its own garage's booking site (<slug>.localhost), axe at 390 and 1440
// Both run on the database engine (available_slots(), create_booking()): booking.spec.ts reads the rows it
// books back and the manage pages always read the database. The in-memory engine (BOOKING_ENGINE=fake,
// src/lib/booking-engine/fake.ts) is for UI work under `pnpm dev` only.
//   pnpm test:e2e:super-admin super-admin.spec.ts /admin (P4.5) for a platform admin signed in with password + TOTP: 404 for everyone else,
//                        garages, plan/status, read-only impersonation, job health; axe at 390 and 1440
//   booking-page-settings.spec.ts  /app/settings/booking-page: free link + QR, custom domain (mock Vercel), embed CSP
//                          on the garage host, Askbridge setting, manager read only (project booking-page-settings)
//   pnpm test:e2e:legal    legal.spec.ts    /privacy and /unsubscribe at 390px (also part of test:e2e:booking)
//   pnpm test:e2e:signup   signup.spec.ts   sign-up → email confirmation (local Mailpit) → onboarding → the new
//                          garage's booking page on <slug>.localhost, timed (< 15 min), axe at 390 and 1440
//   pnpm test:e2e:gate3    gate3.spec.ts    Gate 3: reminders.schedule drained by the server (POST /api/jobs/drain),
//                          reminders.send on the mock SMS channel, the /r/ link opened on <slug>.localhost, the five
//                          steps, attribution in the database, Today's "Won back by reminders"; axe at 390 and 1440
const supabase = getLocalSupabaseConfig();
const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const bookingOrigin = `http://hartley-road.localhost:${port}`;
// Use a preinstalled Chromium (for example in sandboxes without a Playwright download).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: garageSpecs,
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
      // Sign-up's Google Places search uses the recorded fixtures (src/lib/places/fixtures.ts).
      PLACES_PROVIDER: "mock",
      // Gate 2 runs on the real engine, whatever the shell exports (see the header).
      BOOKING_ENGINE: "supabase",
      // Production builds refuse to seal the booking cookies or sign manage links without keys. CI generates its
      // own per job; these fallbacks are for local runs only and are not secrets.
      BOOKING_STATE_SECRET: process.env.BOOKING_STATE_SECRET || "playwright-local-booking-state-key-not-a-secret",
      // tests/helpers/booking-fixtures.ts and tests/e2e/legal.spec.ts derive link tokens with the same value.
      BOOKING_MANAGEMENT_SECRET: process.env.BOOKING_MANAGEMENT_SECRET || "playwright-local-booking-manage-key-not-a-secret",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
      // Mock channels only (no real texts or emails), whatever the shell exports.
      MESSAGING_MODE: "mock",
      // P5.4: payments on the mock provider (no money moves), whatever the shell exports.
      PAYMENTS_PROVIDER: "mock",
      // POST /api/jobs/drain and GET /api/cron/[job] for gate3.spec.ts (a local-only value, tests/helpers/jobs.ts).
      CRON_SECRET: PLAYWRIGHT_CRON_SECRET,
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
    // The admin at desktop width (sidebar) and on a phone (tab bar), on the admin host.
    {
      name: "admin-chromium",
      testMatch: "admin.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: adminOrigin },
    },
    {
      name: "admin-390",
      testMatch: "admin.spec.ts",
      use: { ...devices["Pixel 5"], browserName: "chromium", viewport: { width: 390, height: 844 }, baseURL: adminOrigin },
    },
    // Every page the admin shell links to, plus Customers, Enquiries, Invoices and Trash journeys: its own garages and
    // owner; the spec checks 390 and 1440 itself (part of `pnpm test:e2e:admin`).
    { name: "admin-pages", testMatch: "admin-pages.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    // Setup pages: its own garage and signed-in owner; the spec checks 390 and 1440 itself.
    { name: "settings", testMatch: "settings.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    // Super admin: its own garage, owner and platform admin; the spec checks 390 and 1440 itself.
    { name: "super-admin", testMatch: "super-admin.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    // Booking page & domain settings (P4.3/P4.6): its own garage, owner and manager; axe at 390 and 1440.
    { name: "booking-page-settings", testMatch: "booking-page-settings.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    // Sign-up and onboarding (admin host, its own garage and users); the spec checks 390 and 1440 itself.
    { name: "signup", testMatch: "signup.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    // Gate 3: its own garage, owner and customer (the customer on a 390 phone, the owner at 1440); axe at 390 and 1440.
    { name: "gate3", testMatch: "gate3.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    // P5.4 payments (mock provider): its own garage, owner and customers; axe at 390 and 1440, screenshots.
    { name: "p5-payments", testMatch: "p5-payments.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminOrigin } },
    { name: "legal-mobile", testMatch: "legal.spec.ts", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, baseURL: bookingOrigin } },
  ],
});
