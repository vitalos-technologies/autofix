import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichImportedVehicles, enrichmentUpdate } from "@/lib/customers/enrichment";
import { getConfiguredEnrichmentLookup, resetConfiguredVehicleProviderForTests, type EnrichmentLookup } from "@/lib/vehicle/configured-provider";
import { vehicleLookupError } from "@/lib/vehicle/provider";

// Background DVSA enrichment of imported vehicles (P3.11), against an
// in-memory vehicles table and the mock provider.

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => null }));

type Vehicle = {
  id: string;
  garage_id: string;
  import_id: string | null;
  registration: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  fuel: string | null;
  year: number | null;
  last_mileage: number | null;
  mot_expiry: string | null;
  mot_checked_at: string | null;
  enrichment_status: string | null;
  enrichment_attempts: number;
  created_at: string;
};

const GARAGE = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000001";

function vehicle(index: number, overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: `v${index}`,
    garage_id: GARAGE,
    import_id: "import-1",
    registration: `AB${String(index).padStart(2, "0")}CDE`,
    make: null,
    model: null,
    colour: null,
    fuel: null,
    year: null,
    last_mileage: null,
    mot_expiry: null,
    mot_checked_at: null,
    enrichment_status: "pending",
    enrichment_attempts: 0,
    created_at: `2026-10-27T10:00:${String(index).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

/** Just enough of the Supabase query builder for enrichment: eq filters, order, limit, update, head count. */
function memoryClient(rows: Vehicle[]) {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const client = {
    updates,
    from(table: string) {
      expect(table).toBe("vehicles");
      const filters: Array<[string, unknown]> = [];
      let mode: "select" | "update" | "count" = "select";
      let values: Record<string, unknown> = {};
      let limit = Infinity;
      const matching = () => rows.filter((row) => filters.every(([column, value]) => row[column as keyof Vehicle] === value));
      const builder = {
        select(_columns: string, options?: { head?: boolean }) {
          if (options?.head) mode = "count";
          return builder;
        },
        update(next: Record<string, unknown>) {
          mode = "update";
          values = next;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order() {
          return builder;
        },
        limit(value: number) {
          limit = value;
          return builder;
        },
        then(resolve: (value: unknown) => void) {
          if (mode === "update") {
            for (const row of matching()) {
              Object.assign(row, values);
              updates.push({ id: row.id, values });
            }
            return resolve({ data: null, error: null });
          }
          if (mode === "count") return resolve({ count: matching().length, error: null });
          const found = matching().sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit);
          return resolve({ data: found.map((row) => ({ ...row })), error: null });
        },
      };
      return builder;
    },
  };
  return client;
}

const now = () => new Date("2026-10-27T12:00:00.000Z");
const noSleep = async () => undefined;

function lookupFrom(answer: (registration: string) => Promise<Awaited<ReturnType<EnrichmentLookup["lookup"]>>>): EnrichmentLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    source: "dvsa",
    calls,
    lookup: async (registration) => {
      calls.push(registration);
      return answer(registration);
    },
  };
}

afterEach(() => resetConfiguredVehicleProviderForTests());

describe("enrichImportedVehicles", () => {
  it("writes MOT expiry, mileage and missing facts for pending vehicles of the garage", async () => {
    const rows = [vehicle(1, { make: "Ford" }), vehicle(2), vehicle(3, { garage_id: OTHER })];
    const client = memoryClient(rows);
    const lookup = lookupFrom(async () => ({ motExpiry: "2027-03-31", lastMileage: 42_000, make: "Vauxhall", model: "Astra", fuel: "Petrol", year: 2017 }));

    const result = await enrichImportedVehicles({ garageId: GARAGE, client: client as never, lookup, now, sleep: noSleep });

    expect(result).toEqual({ checked: 2, enriched: 2, notFound: 0, failed: 0, remaining: false, stoppedReason: "done" });
    expect(lookup.calls).toEqual(["AB01CDE", "AB02CDE"]);
    expect(rows[0]).toMatchObject({ make: "Ford", model: "Astra", mot_expiry: "2027-03-31", last_mileage: 42_000, enrichment_status: "done", mot_checked_at: "2026-10-27T12:00:00.000Z" });
    expect(rows[2]).toMatchObject({ enrichment_status: "pending", mot_expiry: null });
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    const rows = [vehicle(1)];
    const client = memoryClient(rows);
    const lookup = lookupFrom(async () => ({ motExpiry: "2027-03-31" }));
    await enrichImportedVehicles({ garageId: GARAGE, client: client as never, lookup, now, sleep: noSleep });
    const again = await enrichImportedVehicles({ garageId: GARAGE, client: client as never, lookup, now, sleep: noSleep });
    expect(again).toMatchObject({ checked: 0, enriched: 0, remaining: false });
    expect(lookup.calls).toHaveLength(1);
  });

  it("limits a run, filters by import, and says when more remain", async () => {
    const rows = [vehicle(1), vehicle(2), vehicle(3), vehicle(4, { import_id: "import-2" })];
    const client = memoryClient(rows);
    const lookup = lookupFrom(async () => ({ motExpiry: "2027-01-01" }));
    const result = await enrichImportedVehicles({ garageId: GARAGE, importId: "import-1", limit: 2, client: client as never, lookup, now, sleep: noSleep });
    expect(result).toMatchObject({ checked: 2, remaining: true, stoppedReason: "limit" });
    expect(rows.map((row) => row.enrichment_status)).toEqual(["done", "done", "pending", "pending"]);
  });

  it("marks unknown registrations not_found", async () => {
    const rows = [vehicle(1), vehicle(2, { registration: null })];
    const client = memoryClient(rows);
    const lookup = lookupFrom(async () => {
      throw vehicleLookupError("not_found", { source: "dvsa", status: 404 });
    });
    const result = await enrichImportedVehicles({ garageId: GARAGE, client: client as never, lookup, now, sleep: noSleep });
    expect(result).toMatchObject({ notFound: 2, enriched: 0 });
    expect(rows.map((row) => row.enrichment_status)).toEqual(["not_found", "not_found"]);
  });

  it("stops on a rate limit and leaves the rest pending", async () => {
    const rows = [vehicle(1), vehicle(2), vehicle(3), vehicle(4), vehicle(5), vehicle(6)];
    const client = memoryClient(rows);
    let count = 0;
    const lookup = lookupFrom(async () => {
      count += 1;
      if (count === 2) throw vehicleLookupError("rate_limited", { source: "dvsa", status: 429, retryAfterMs: 2_000 });
      return { motExpiry: "2027-01-01" };
    });
    const result = await enrichImportedVehicles({ garageId: GARAGE, concurrency: 2, client: client as never, lookup, now, sleep: noSleep });
    expect(result).toMatchObject({ stoppedReason: "rate_limited", remaining: true, retryAfterMs: 2_000, enriched: 1 });
    expect(lookup.calls).toHaveLength(2);
    expect(rows.filter((row) => row.enrichment_status === "pending")).toHaveLength(5);
  });

  it("retries a failing source and gives up after three attempts", async () => {
    const rows = [vehicle(1)];
    const client = memoryClient(rows);
    const lookup = lookupFrom(async () => {
      throw vehicleLookupError("unavailable", { source: "dvsa", status: 503 });
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await enrichImportedVehicles({ garageId: GARAGE, client: client as never, lookup, now, sleep: noSleep });
      expect(result.failed).toBe(1);
      expect(result.remaining).toBe(attempt < 3);
    }
    expect(rows[0]).toMatchObject({ enrichment_status: "failed", enrichment_attempts: 3 });
  });

  it("pauses between batches", async () => {
    const rows = [vehicle(1), vehicle(2), vehicle(3)];
    const sleep = vi.fn(async () => undefined);
    await enrichImportedVehicles({
      garageId: GARAGE, concurrency: 1, pauseMs: 100, client: memoryClient(rows) as never, lookup: lookupFrom(async () => ({})), now, sleep,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("does nothing when no free source is configured", async () => {
    const result = await enrichImportedVehicles({ garageId: GARAGE, client: memoryClient([vehicle(1)]) as never, lookup: null });
    expect(result).toMatchObject({ stoppedReason: "not_configured", remaining: true, checked: 0 });
  });
});

describe("enrichmentUpdate", () => {
  const base = vehicle(1, { make: "Ford", last_mileage: 50_000 });

  it("keeps known facts and only raises the mileage", () => {
    expect(enrichmentUpdate(base, { motExpiry: "2027-03-31", lastMileage: 40_000, make: "Vauxhall" }, now())).toEqual({
      enrichment_status: "done",
      mot_checked_at: "2026-10-27T12:00:00.000Z",
      mot_expiry: "2027-03-31",
    });
    expect(enrichmentUpdate(base, { lastMileage: 60_000 }, now())).toMatchObject({ last_mileage: 60_000 });
  });

  it("ignores malformed values", () => {
    expect(enrichmentUpdate(vehicle(2), { motExpiry: "31/03/2027", lastMileage: -1, year: 3000 }, now())).toEqual({
      enrichment_status: "done",
      mot_checked_at: "2026-10-27T12:00:00.000Z",
    });
  });
});

describe("getConfiguredEnrichmentLookup", () => {
  it("uses the mock provider in mock mode", async () => {
    const lookup = getConfiguredEnrichmentLookup({ VEHICLE_LOOKUP_PROVIDER: "mock" });
    expect(lookup?.source).toBe("mock");
    expect(await lookup!.lookup("AB12CDE")).toMatchObject({ motExpiry: "2027-03-31", make: "Vauxhall" });
  });

  it("never uses the paid Vehicle Data Global source", () => {
    expect(getConfiguredEnrichmentLookup({
      VEHICLE_LOOKUP_PROVIDER: "vehicle-data-global",
      VEHICLE_DATA_GLOBAL_API_KEY: "key",
      VEHICLE_DATA_GLOBAL_BASE_URL: "https://vdg.example.test",
      VEHICLE_DATA_GLOBAL_PACKAGE: "pkg",
    })).toBeNull();
  });

  it("prefers DVSA MOT History when its credentials are set", () => {
    const lookup = getConfiguredEnrichmentLookup({
      VEHICLE_LOOKUP_PROVIDER: "composite",
      DVSA_MOT_CLIENT_ID: "id",
      DVSA_MOT_CLIENT_SECRET: "secret",
      DVSA_MOT_API_KEY: "key",
      DVSA_MOT_TOKEN_URL: "https://login.example.test/token",
      DVLA_VES_API_KEY: "dvla",
    });
    expect(lookup?.source).toBe("dvsa");
  });

  it("falls back to DVLA when DVSA is not configured", () => {
    expect(getConfiguredEnrichmentLookup({ VEHICLE_LOOKUP_PROVIDER: "dvla", DVLA_VES_API_KEY: "dvla" })?.source).toBe("dvla");
  });
});
