// Lighthouse CI (`pnpm test:lighthouse`), mobile emulation by default.
//
// Booking pages live on garage hosts, which resolve through the database, so
// this needs local Supabase, `pnpm db:seed` (garage hartley-road) and a
// production build made with the Supabase env exported. The port comes from
// LIGHTHOUSE_PORT (per CI runner, scripts/ci/supabase-isolate.sh; 3420 locally).
const port = process.env.LIGHTHOUSE_PORT || "3420";
const bookingOrigin = `http://hartley-road.localhost:${port}`;

const shared = {
  // Median of three runs: single devtools-throttled runs of the same page
  // swing by about 0.05 on a busy machine.
  "categories:performance": ["error", { minScore: 0.9, aggregationMethod: "median" }],
  "categories:best-practices": ["error", { minScore: 0.95 }],
  "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
  "largest-contentful-paint": ["error", { maxNumericValue: 2500 }],
};

module.exports = {
  ci: {
    collect: {
      startServerCommand: `pnpm start -p ${port}`,
      startServerReadyPattern: "Ready",
      url: [`${bookingOrigin}/`, `${bookingOrigin}/manage-booking`],
      numberOfRuns: 3,
      settings: {
        // Chromium resolves *.localhost to loopback itself; the rule keeps it so.
        chromeFlags: '--headless --no-sandbox --host-resolver-rules="MAP *.localhost 127.0.0.1"',
        throttlingMethod: "devtools",
      },
    },
    assert: {
      assertMatrix: [
        {
          // Booking home page (SOB wizard until P2.8): accessibility 100.
          matchingUrlPattern: "^http://[^/]+/$",
          assertions: { ...shared, "categories:accessibility": ["error", { minScore: 1 }] },
        },
        {
          // SOB's manage-booking page scores 0.96 (one colour-contrast failure)
          // until P2.9 restyles it; the existing 0.95 floor stays.
          matchingUrlPattern: "/manage-booking$",
          assertions: { ...shared, "categories:accessibility": ["error", { minScore: 0.95 }] },
        },
      ],
    },
    upload: {
      target: "filesystem",
      outputDir: ".lighthouseci/reports",
    },
  },
};
