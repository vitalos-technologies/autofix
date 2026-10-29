import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { manageLookupSchema } from "@/lib/booking-engine/manage-schema";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

function filesUnder(directory: string): string[] {
  const absolute = join(root, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    return entry.isDirectory() ? filesUnder(relative(root, path)) : [relative(root, path)];
  });
}

describe("native booking management", () => {
  it("requires a reference and registration for a booking lookup", () => {
    expect(manageLookupSchema.safeParse({ reference: "HRM-4821", registration: "AB12 CDE" }).success).toBe(true);
    expect(manageLookupSchema.safeParse({ reference: "HRM-4821" }).success).toBe(false);
  });

  it("accepts any garage's <PREFIX>-NNNN reference and nothing else", () => {
    for (const reference of ["HRM-4821", "AB-1234", "DGBX-123456"]) {
      expect(manageLookupSchema.safeParse({ reference, registration: "AB12CDE" }).success, reference).toBe(true);
    }
    for (const reference of ["H-1234", "HRMXX-1234", "HRM-123", "HRM-1234567", "HRM1234", "12-3456"]) {
      expect(manageLookupSchema.safeParse({ reference, registration: "AB12CDE" }).success, reference).toBe(false);
    }
  });

  it("normalises every lookup factor", () => {
    expect(manageLookupSchema.parse({ reference: " hrm-4821 ", registration: "ab12 cde" })).toEqual({ reference: "HRM-4821", registration: "AB12CDE" });
  });

  it("keeps non-sequential collision-checked references, prefixed and unique per garage", () => {
    const migration = read("supabase", "migrations", "20261026000100_tenancy.sql");
    expect(migration).toContain("floor(random() * (10 ^ digits))");
    expect(migration).toContain("exit when not exists");
    expect(migration).toContain("^[A-Z]{2,4}-[0-9]{4,6}$");
    expect(migration).toContain("unique (garage_id, booking_reference)");
  });

  it("resolves the garage from the host in every public booking route", () => {
    for (const path of [["src", "app", "api", "bookings", "route.ts"], ["src", "app", "api", "bookings", "manage", "route.ts"], ["src", "app", "api", "slots", "route.ts"], ["src", "app", "api", "services", "route.ts"]]) {
      const source = read(...path);
      expect(source, path.join("/")).toContain("await resolveRouteGarage()");
      expect(source, path.join("/")).not.toMatch(/garage_?id"\s*\)|body\.garage|searchParams\.get\("garage/i);
    }
  });

  it("rate-limits lookup, links, rescheduling and cancellation separately", () => {
    const route = read("src", "app", "api", "bookings", "manage", "route.ts");
    for (const scope of ["booking_lookup_ip", "booking_lookup_details", "booking_manage_link", "booking_reschedule", "booking_cancel"]) {
      expect(route).toContain(`"${scope}"`);
    }
  });

  it("keeps registrations out of URLs: lookups are POST bodies and the slots query is strict", () => {
    const route = read("src", "app", "api", "bookings", "manage", "route.ts");
    expect(route).toContain("export async function POST");
    expect(route).not.toMatch(/searchParams\.get\("(registration|reg|vrm)"/i);
    expect(read("src", "app", "api", "slots", "route.ts")).toContain(".strict()");
  });

  it("removes Cal.com from the application", () => {
    const legacy = new RegExp(["cal", "com"].join(""), "i");
    const files = [...filesUnder("src"), ".env.example", "package.json"].filter((file) => file !== join("src", "__tests__", "booking-management.test.ts"));
    expect(files.filter((file) => legacy.test(readFileSync(join(root, file), "utf8")))).toEqual([]);
  });

  it("rejects reintroduced legacy scheduling integration outside compatibility migrations", () => {
    const legacyName = ["calen", "dly"].join("");
    const forbidden = new RegExp(`${legacyName}|${legacyName}\\.com|${legacyName.toUpperCase()}_`, "i");
    // The build plan names the legacy table it schedules for removal (P2.1).
    const historicalMigrations = new Set([
      join("docs", "autofix", "BUILD-PLAN.md"),
    ]);
    // docs/autofix/ is the Pitline planning kit; it names the legacy scheduler
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
