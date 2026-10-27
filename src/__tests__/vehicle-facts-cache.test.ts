import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryVehicleFactsCache,
  createSupabaseVehicleFactsCache,
  hashRegistration,
  isFresh,
  toStoredFacts,
  VEHICLE_FACTS_MAX_AGE_MS,
  type VehicleFacts,
} from "@/lib/vehicle/facts-cache";
import { fakeClock } from "./fixtures/vehicle/fake-http";

const PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const REG = "AB12CDE";
const hash = hashRegistration(REG, PEPPER);

const facts: VehicleFacts = {
  version: 1,
  vehicle: { make: "Vauxhall", model: "Astra", motExpiry: "2027-03-22", motStatus: "Valid" },
  mot: {
    motExpiry: "2027-03-22",
    lastMotTestDate: "2026-03-14",
    lastMileage: 84213,
    mileageUnit: "mi",
    motTests: [{ completedDate: "2026-03-14T10:42:17.000Z", result: "passed", expiryDate: "2027-03-22", odometer: { value: 84213, unit: "mi" }, defects: [{ type: "advisory", text: "Tyre worn close to legal limit" }] }],
  },
  sources: ["dvla", "dvsa"],
};

describe("hashRegistration", () => {
  it("is a hex HMAC-SHA-256 of the normalised registration", () => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRegistration("ab12 cde", PEPPER)).toBe(hash);
    expect(hashRegistration("AB12-CDE", PEPPER)).toBe(hash);
    expect(hash).not.toContain(REG.toLowerCase());
  });

  it("depends on the pepper", () => {
    expect(hashRegistration(REG, `${PEPPER}x`)).not.toBe(hash);
  });

  it("refuses to hash without a pepper or registration", () => {
    expect(() => hashRegistration(REG, "")).toThrow(/VEHICLE_FACTS_PEPPER/);
    expect(() => hashRegistration(" - ", PEPPER)).toThrow();
  });
});

describe("freshness", () => {
  it("is fresh for 24 hours by fetched_at", () => {
    const fetchedAt = new Date("2026-10-25T09:00:00.000Z");
    expect(isFresh(fetchedAt, new Date("2026-10-26T08:59:59.999Z"))).toBe(true);
    expect(isFresh(fetchedAt, new Date("2026-10-26T09:00:00.000Z"))).toBe(false);
    expect(isFresh(fetchedAt, new Date("2026-10-24T09:00:00.000Z"))).toBe(false);
    expect(VEHICLE_FACTS_MAX_AGE_MS).toBe(86_400_000);
  });
});

describe("stored facts shape", () => {
  it("strips anything that is not a whitelisted vehicle fact", () => {
    const polluted = {
      ...facts,
      registration: REG,
      customer: { name: "Sam Driver", email: "sam@example.com" },
      vehicle: { ...facts.vehicle, registration: REG, vin: "W0L0PXXXXXX000000", phone: "+447700900123" },
      mot: { ...facts.mot, registration: REG, motTests: [{ ...facts.mot?.motTests[0], registrationAtTimeOfTest: REG, motTestNumber: "512345678901" }] },
    };
    const stored = toStoredFacts(polluted);
    expect(stored).toEqual(facts);
    expect(JSON.stringify(stored)).not.toContain(REG);
  });

  it("rejects unknown versions and malformed values", () => {
    expect(toStoredFacts({ ...facts, version: 2 })).toBeNull();
    expect(toStoredFacts({ ...facts, vehicle: { motExpiry: "22/03/2027" } })).toBeNull();
    expect(toStoredFacts(null)).toBeNull();
  });
});

describe("memory cache", () => {
  it("returns what was set, as a copy", async () => {
    const cache = createMemoryVehicleFactsCache();
    const fetchedAt = new Date("2026-10-26T09:00:00.000Z");
    await cache.set(hash, facts, fetchedAt);
    const first = await cache.get(hash);
    expect(first).toEqual({ facts, fetchedAt });
    if (first) first.facts.vehicle.make = "Changed";
    expect((await cache.get(hash))?.facts.vehicle.make).toBe("Vauxhall");
  });

  it("misses for unknown keys and refuses keys that are not hashes", async () => {
    const cache = createMemoryVehicleFactsCache();
    expect(await cache.get(hash)).toBeNull();
    await cache.set(REG, facts);
    expect(cache.size()).toBe(0);
    expect(await cache.get(REG)).toBeNull();
  });

  it("evicts the oldest entries beyond its size limit", async () => {
    const cache = createMemoryVehicleFactsCache({ maxEntries: 2 });
    const keys = ["AA11AAA", "BB22BBB", "CC33CCC"].map((reg) => hashRegistration(reg, PEPPER));
    for (const key of keys) await cache.set(key, facts);
    expect(cache.size()).toBe(2);
    expect(await cache.get(keys[0] as string)).toBeNull();
    expect(await cache.get(keys[2] as string)).not.toBeNull();
  });
});

type Row = { reg_hash: string; facts: unknown; fetched_at: string };
type DbError = { code: string; message: string };

/** Just enough of the Supabase query builder for vehicle_facts. */
function fakeSupabase(options: { rows?: Row[]; readError?: DbError; writeError?: DbError; throws?: boolean } = {}) {
  const rows = new Map((options.rows ?? []).map((row) => [row.reg_hash, row]));
  const upserts: Array<{ table: string; values: Row; options: unknown }> = [];
  const selects: Array<{ table: string; columns: string; column: string; value: string }> = [];
  const client = {
    from(table: string) {
      if (options.throws) throw new Error("network down");
      return {
        select(columns: string) {
          return {
            eq(column: string, value: string) {
              selects.push({ table, columns, column, value });
              return {
                async maybeSingle() {
                  if (options.readError) return { data: null, error: options.readError };
                  const row = rows.get(value);
                  return { data: row ? { facts: row.facts, fetched_at: row.fetched_at } : null, error: null };
                },
              };
            },
          };
        },
        async upsert(values: Row, upsertOptions: unknown) {
          upserts.push({ table, values, options: upsertOptions });
          if (options.writeError) return { error: options.writeError };
          rows.set(values.reg_hash, values);
          return { error: null };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, upserts, selects, rows };
}

const missingTable = { code: "PGRST205", message: "Could not find the table 'public.vehicle_facts' in the schema cache" };

describe("Supabase cache", () => {
  it("upserts by reg_hash with facts and fetched_at", async () => {
    const db = fakeSupabase();
    const cache = createSupabaseVehicleFactsCache({ client: db.client, logger: { warn: vi.fn() } });
    await cache.set(hash, { ...facts, registration: REG } as VehicleFacts, new Date("2026-10-26T09:00:00.000Z"));

    expect(db.upserts).toEqual([{
      table: "vehicle_facts",
      values: { reg_hash: hash, facts, fetched_at: "2026-10-26T09:00:00.000Z" },
      options: { onConflict: "reg_hash" },
    }]);
    expect(JSON.stringify(db.upserts)).not.toContain(REG);
  });

  it("reads facts and fetched_at back by reg_hash", async () => {
    const db = fakeSupabase({ rows: [{ reg_hash: hash, facts, fetched_at: "2026-10-26T08:00:00+00:00" }] });
    const cache = createSupabaseVehicleFactsCache({ client: db.client });
    const hit = await cache.get(hash);
    expect(hit).toEqual({ facts, fetchedAt: new Date("2026-10-26T08:00:00.000Z") });
    expect(db.selects).toEqual([{ table: "vehicle_facts", columns: "facts, fetched_at", column: "reg_hash", value: hash }]);
  });

  it("fails soft when the table does not exist yet: one warning with the code only, then misses", async () => {
    const clock = fakeClock();
    const logger = { warn: vi.fn() };
    const db = fakeSupabase({ readError: missingTable, writeError: missingTable });
    const cache = createSupabaseVehicleFactsCache({ client: db.client, logger, now: clock.now });

    expect(await cache.get(hash)).toBeNull();
    await cache.set(hash, facts);
    expect(await cache.get(hash)).toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("vehicle_facts table is missing"), { code: "PGRST205" });
    // Skipped while the table is known to be missing, retried later.
    expect(db.selects).toHaveLength(1);
    expect(db.upserts).toHaveLength(0);
    clock.advance(5 * 60 * 1000);
    await cache.get(hash);
    expect(db.selects).toHaveLength(2);
  });

  it("treats Postgres undefined_table the same way", async () => {
    const logger = { warn: vi.fn() };
    const cache = createSupabaseVehicleFactsCache({ client: fakeSupabase({ readError: { code: "42P01", message: 'relation "vehicle_facts" does not exist' } }).client, logger });
    expect(await cache.get(hash)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { code: "42P01" });
  });

  it("treats other errors, exceptions and odd rows as misses without leaking details", async () => {
    const logger = { warn: vi.fn() };
    const thrown = createSupabaseVehicleFactsCache({ client: fakeSupabase({ throws: true }).client, logger });
    expect(await thrown.get(hash)).toBeNull();
    await expect(thrown.set(hash, facts)).resolves.toBeUndefined();

    const odd = createSupabaseVehicleFactsCache({ client: fakeSupabase({ rows: [{ reg_hash: hash, facts: { version: 1 }, fetched_at: "yesterday" }] }).client, logger });
    expect(await odd.get(hash)).toBeNull();

    const failingWrite = createSupabaseVehicleFactsCache({ client: fakeSupabase({ writeError: { code: "23505", message: `duplicate key (reg_hash)=(${hash})` } }).client, logger });
    await failingWrite.set(hash, facts);

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(hash);
    expect(logged).not.toContain(REG);
    expect(logged).not.toContain("network down");
  });

  it("is a silent miss without a service-role client", async () => {
    const logger = { warn: vi.fn() };
    const cache = createSupabaseVehicleFactsCache({ client: () => null, logger });
    expect(await cache.get(hash)).toBeNull();
    await cache.set(hash, facts);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("refuses keys that are not hashes", async () => {
    const db = fakeSupabase();
    const cache = createSupabaseVehicleFactsCache({ client: db.client });
    await cache.set(REG, facts);
    expect(await cache.get(REG)).toBeNull();
    expect(db.upserts).toHaveLength(0);
    expect(db.selects).toHaveLength(0);
  });
});
