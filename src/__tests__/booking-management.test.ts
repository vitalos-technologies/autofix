import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBookingAccessToken, verifyBookingAccessToken } from "@/lib/bookings/access-token";
import { bookingLookupSchema, createBookingSchema } from "@/lib/bookings/schema";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

function filesUnder(directory: string): string[] {
  const absolute = join(root, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    return entry.isDirectory() ? filesUnder(relative(root, path)) : [relative(root, path)];
  });
}

describe("provider-neutral booking management", () => {
  beforeEach(() => {
    process.env.BOOKING_MANAGEMENT_SECRET = "booking-management-test-secret-with-enough-entropy";
  });

  afterEach(() => {
    delete process.env.BOOKING_MANAGEMENT_SECRET;
  });

  it("requires a reference and registration for a booking lookup", () => {
    expect(bookingLookupSchema.safeParse({ bookingReference: "HRM-4821", registration: "AB12 CDE" }).success).toBe(true);
    expect(bookingLookupSchema.safeParse({ bookingReference: "HRM-4821" }).success).toBe(false);
  });

  it("accepts any garage's <PREFIX>-NNNN reference and nothing else", () => {
    for (const reference of ["HRM-4821", "AB-1234", "DGBX-123456"]) {
      expect(bookingLookupSchema.safeParse({ bookingReference: reference, registration: "AB12CDE" }).success, reference).toBe(true);
    }
    for (const reference of ["H-1234", "HRMXX-1234", "HRM-123", "HRM-1234567", "HRM1234", "12-3456"]) {
      expect(bookingLookupSchema.safeParse({ bookingReference: reference, registration: "AB12CDE" }).success, reference).toBe(false);
    }
  });

  it("normalises every secure lookup factor", () => {
    expect(bookingLookupSchema.parse({ bookingReference: " hrm-4821 ", registration: "ab12 cde" })).toEqual({
      bookingReference: "HRM-4821",
      registration: "AB12CDE",
    });
  });

  it("issues a valid short-lived booking access token for one garage", () => {
    const token = createBookingAccessToken("booking-id", "garage-a", 60);
    expect(verifyBookingAccessToken(token, "garage-a")).toMatchObject({ bookingId: "booking-id", garageId: "garage-a" });
  });

  it("rejects a token presented on another garage's site", () => {
    const token = createBookingAccessToken("booking-id", "garage-a", 60);
    expect(verifyBookingAccessToken(token, "garage-b")).toBeNull();
  });

  it("rejects a tampered booking access token", () => {
    const token = createBookingAccessToken("booking-id", "garage-a", 60);
    expect(verifyBookingAccessToken(`${token}x`, "garage-a")).toBeNull();
  });

  it("rejects an expired booking access token", () => {
    expect(verifyBookingAccessToken(createBookingAccessToken("booking-id", "garage-a", -1), "garage-a")).toBeNull();
  });

  it("keeps non-sequential collision-checked references, prefixed and unique per garage", () => {
    const migration = read("supabase", "migrations", "20261026000100_tenancy.sql");
    expect(migration).toContain("floor(random() * (10 ^ digits))");
    expect(migration).toContain("exit when not exists");
    expect(migration).toContain("^[A-Z]{2,4}-[0-9]{4,6}$");
    expect(migration).toContain("unique (garage_id, booking_reference)");
  });

  it("adds provider-neutral booking correlation and sync fields", () => {
    const migration = read("supabase", "migrations", "20261026000000_baseline.sql");
    expect(migration).toContain("provider_booking_uid text");
    expect(migration).toContain("provider_event_type_id bigint");
    expect(migration).toContain("provider_sync_state");
  });

  it("reserves booking creation through an idempotent database function", () => {
    const migration = read("supabase", "migrations", "20261026000100_tenancy.sql");
    expect(migration).toContain("create_booking_intent");
    expect(migration).toContain("idempotency_key");
    expect(migration).toContain("IDEMPOTENCY_KEY_REQUIRED");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("when unique_violation");
  });

  it("ships service mappings disabled until real event types are configured", () => {
    const migration = read("supabase", "migrations", "20261026000000_baseline.sql");
    expect(migration).toContain("online_booking_enabled boolean not null default false");
    expect(migration).toContain("not online_booking_enabled or provider_event_type_id is not null");
    expect(migration).toContain("provider_event_type_id > 0");
    expect(migration).not.toMatch(/provider_event_type_id\s*,?\s*\)\s*values[\s\S]{0,400}\b\d{2,}\b/i);
  });

  it("validates complete server-side booking data", () => {
    const result = createBookingSchema.safeParse({
      vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
      serviceKey: "vehicle-diagnostics",
      problemDescription: "",
      symptoms: ["warning light"],
      conditionalAnswers: { warningLight: "Engine management" },
      location: { mode: "workshop" },
      customer: { name: "Test Customer", email: "test@example.com", phone: "07000 000000" },
      appointmentStart: "2026-08-18T09:00:00.000Z",
      idempotencyKey: "70ca0b0b-1df7-42f4-8fe1-329c54ace42d",
    });
    expect(result.success).toBe(true);
  });

  it("requires a mobile address and postcode only for mobile work", () => {
    const base = {
      vehicle: { registration: "AB12 CDE" },
      serviceKey: "mobile-diagnostic-visit",
      problemDescription: "The vehicle will not start consistently.",
      symptoms: [],
      conditionalAnswers: {},
      customer: { name: "Test Customer", email: "test@example.com", phone: "07000 000000" },
      appointmentStart: "2026-08-18T09:00:00.000Z",
      idempotencyKey: "70ca0b0b-1df7-42f4-8fe1-329c54ace42d",
    };
    expect(createBookingSchema.safeParse({ ...base, location: { mode: "mobile" } }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, location: { mode: "mobile", address: "1 Station Road", postcode: "DN6 9HF" } }).success).toBe(true);
  });

  it("keeps rescheduling and cancellation inside the product", () => {
    const actions = read("src", "lib", "bookings", "manage-actions.ts");
    const component = read("src", "components", "booking", "manage-booking.tsx");
    expect(actions).toContain("getBookingRescheduleSlots");
    expect(actions).toContain("rescheduleBooking");
    expect(actions).toContain("cancelBooking");
    expect(component).not.toContain("window.location");
    // Every action resolves the garage from the request host, never from the client.
    expect(actions.match(/await getHostGarage\(\)/g)?.length).toBe(5);
    expect(actions).not.toMatch(/formData\.get\("garage/i);
  });

  it("rate-limits lookup, slot browsing, reschedule and cancellation separately", () => {
    const actions = read("src", "lib", "bookings", "manage-actions.ts");
    expect(actions).toContain("booking_lookup_ip");
    expect(actions).toContain("booking_reschedule_slots");
    expect(actions).toContain('"booking_reschedule"');
    expect(actions).toContain("booking_cancel");
  });

  it("preserves history and hides provider identifiers from the customer view", () => {
    const component = read("src", "components", "booking", "manage-booking.tsx");
    expect(component).toContain("Booking history");
    expect(component).toContain("booking.history");
    expect(component).not.toContain("provider_booking_uid");
    expect(component).not.toContain("eventTypeId");
  });

  it("rejects reintroduced legacy scheduling integration outside compatibility migrations", () => {
    const legacyName = ["calen", "dly"].join("");
    const forbidden = new RegExp(`${legacyName}|${legacyName}\\.com|${legacyName.toUpperCase()}_`, "i");
    // The build plan names the legacy table it schedules for removal (P2.1).
    const historicalMigrations = new Set([
      join("docs", "autofix", "BUILD-PLAN.md"),
    ]);
    // docs/autofix/ is the Autofix planning kit; it names the legacy scheduler
    // only to record that it is not used. Every SOB doc and all of src/ stay scanned.
    const autofixPlanningDocs = join("docs", "autofix") + sep;
    const candidates = [
      ...filesUnder("src"),
      ...filesUnder("docs").filter((file) => !file.startsWith(autofixPlanningDocs)),
      ".env.example",
      "README.md",
      "next.config.ts",
      "package.json",
      "pnpm-lock.yaml",
    ].filter((file) => !historicalMigrations.has(file) && file !== join("src", "__tests__", "booking-management.test.ts"));
    const matches = candidates.filter((file) => forbidden.test(readFileSync(join(root, file), "utf8")));
    expect(matches).toEqual([]);
  });
});
