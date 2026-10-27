/**
 * Specs that run against a garage booking host (playwright.garage.config.ts) and need seeded Supabase.
 * The default config (playwright.config.ts, admin host, no database) ignores exactly these.
 */
export const garageSpecs = ["smoke.spec.ts", "booking.spec.ts", "manage.spec.ts", "settings.spec.ts", "legal.spec.ts", "admin.spec.ts"];
