// Lighthouse with the Askbridge widget on (P4.6): `node scripts/lighthouse-askbridge.mjs`, which turns the
// chat on for the seeded garage hartley-road, serves the local widget stub (scripts/askbridge-widget-stub.mjs)
// and restores the garage afterwards. Needs a production build made with
// NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL=http://127.0.0.1:4100/widget/v1/askbridge.js and the Supabase env exported
// (without it the build loads the real Askbridge loader, which refuses a localhost page).
// Booking routes must keep performance >= 0.9 and accessibility 1 on mobile with the widget loading.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- lhci reads CommonJS configs
const base = require("./lighthouserc.cjs");

const port = process.env.LIGHTHOUSE_PORT || "3420";
const bookingOrigin = `http://hartley-road.localhost:${port}`;
const shared = base.ci.assert.assertMatrix[0].assertions;

module.exports = {
  ci: {
    collect: { ...base.ci.collect, url: [`${bookingOrigin}/`, `${bookingOrigin}/manage`] },
    assert: { assertMatrix: [{ matchingUrlPattern: ".*", assertions: { ...shared, "categories:accessibility": ["error", { minScore: 1 }] } }] },
    upload: { target: "filesystem", outputDir: "output/lighthouse-askbridge" },
  },
};
