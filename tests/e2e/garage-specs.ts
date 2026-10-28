/**
 * Specs that run against a garage booking host (playwright.garage.config.ts) and need seeded Supabase.
 * The default config (playwright.config.ts, admin host, no database) ignores exactly these.
 */
export const garageSpecs = ["smoke.spec.ts", "booking.spec.ts", "manage.spec.ts", "settings.spec.ts", "legal.spec.ts", "super-admin.spec.ts", "admin.spec.ts", "admin-pages.spec.ts","booking-page-settings.spec.ts", "signup.spec.ts", "gate3.spec.ts", "p5-ai-front-desk.spec.ts"];
