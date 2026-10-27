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
      // P4.7: the booking routes a customer opens directly (the later steps need the sealed draft cookie
      // and redirect to / without it; Playwright covers them with axe at 390px).
      url: [`${bookingOrigin}/`, `${bookingOrigin}/manage`, `${bookingOrigin}/privacy`, `${bookingOrigin}/unsubscribe`],
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
          // Every booking route: performance 90 (median), accessibility 100 (BUILD-PLAN P4.7).
          matchingUrlPattern: "^http://[^/]+/(manage|privacy|unsubscribe)?$",
          assertions: { ...shared, "categories:accessibility": ["error", { minScore: 1 }] },
        },
      ],
    },
    upload: {
      target: "filesystem",
      outputDir: ".lighthouseci/reports",
    },
  },
};
