import { describe, expect, it, vi } from "vitest";
import { createCompositeProvider, mergeVehicleFacts, type CompositeProviderOptions } from "@/lib/vehicle/composite";
import { DvlaProvider } from "@/lib/vehicle/dvla";
import { DvsaMotHistoryClient, parseDvsaVehicle, type DvsaVehicle, type MotHistoryLookup } from "@/lib/vehicle/dvsa";
import {
  createMemoryVehicleFactsCache,
  hashRegistration,
  type VehicleFacts,
  type VehicleFactsCache,
} from "@/lib/vehicle/facts-cache";
import { vehicleLookupError, VehicleLookupError, type VehicleLookupProvider } from "@/lib/vehicle/provider";
import { VehicleDataGlobalProvider } from "@/lib/vehicle/vehicle-data-global";
import type { VehicleDetails } from "@/types/domain";
import dvlaFixture from "./fixtures/vehicle/dvla-ab12cde.json";
import dvlaNewFixture from "./fixtures/vehicle/dvla-ab74cde-new.json";
import dvlaErrors from "./fixtures/vehicle/dvla-errors.json";
import dvsaFixture from "./fixtures/vehicle/dvsa-ab12cde.json";
import dvsaNewFixture from "./fixtures/vehicle/dvsa-ab74cde-new.json";
import dvsaErrors from "./fixtures/vehicle/dvsa-errors.json";
import dvsaToken from "./fixtures/vehicle/dvsa-token.json";
import vdgFixture from "./fixtures/vehicle/vdg-ab12cde.json";
import { describeError, fakeClock, fakeFetch, json } from "./fixtures/vehicle/fake-http";

const PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const REG = "AB12CDE";
const TODAY = "2026-10-26";

const dvlaAstra: VehicleDetails = {
  registration: REG,
  make: "Vauxhall",
  year: 2012,
  colour: "Blue",
  fuelType: "Petrol",
  engineCapacityCc: 1398,
  motStatus: "Valid",
  motExpiry: "2027-03-22",
  taxStatus: "Taxed",
  taxDueDate: "2027-04-01",
};

const dvsaAstra: DvsaVehicle = parseDvsaVehicle(dvsaFixture);

const vdgAstra: VehicleDetails = {
  registration: REG,
  make: "Vauxhall",
  model: "Astra",
  derivative: "Sri",
  year: 2012,
  colour: "Blue",
  fuelType: "Petrol",
  transmission: "Manual",
  engineCapacityCc: 1398,
  bodyType: "Hatchback",
};

function source(result: VehicleDetails | VehicleLookupError) {
  return { lookup: vi.fn(async () => {
    if (result instanceof VehicleLookupError) throw result;
    return { ...result };
  }) } satisfies VehicleLookupProvider;
}

function dvsaSource(result: DvsaVehicle | VehicleLookupError) {
  return { getMotHistory: vi.fn(async () => {
    if (result instanceof VehicleLookupError) throw result;
    return structuredClone(result);
  }) } satisfies MotHistoryLookup;
}

function spyCache(inner: VehicleFactsCache = createMemoryVehicleFactsCache()) {
  return {
    get: vi.fn((regHash: string) => inner.get(regHash)),
    set: vi.fn((regHash: string, facts: VehicleFacts, fetchedAt?: Date) => inner.set(regHash, facts, fetchedAt)),
  };
}

const silent = { warn: vi.fn() };

function composite(options: CompositeProviderOptions, clock = fakeClock()) {
  return createCompositeProvider({ now: clock.date, logger: silent, ...options });
}

describe("merge rules", () => {
  it("takes DVLA make/colour/fuel, DVSA MOT expiry and VDG model/derivative", () => {
    const facts = mergeVehicleFacts({
      dvla: { ...dvlaAstra, make: "Vauxhall", colour: "Blue", fuelType: "Petrol", motExpiry: "2026-03-22", motStatus: "Not valid" },
      dvsa: { ...dvsaAstra, make: "Opel", colour: "Navy", fuelType: "Diesel", model: "Astra Gtc" },
      vdg: { ...vdgAstra, make: "Vauxhall Motors", colour: "Red", model: "Astra", derivative: "Sri" },
    }, TODAY);

    expect(facts.vehicle).toMatchObject({
      make: "Vauxhall",
      colour: "Blue",
      fuelType: "Petrol",
      model: "Astra",
      derivative: "Sri",
      transmission: "Manual",
      bodyType: "Hatchback",
      // DVSA's expiry wins over DVLA's, and the status follows DVSA's test history.
      motExpiry: "2027-03-22",
      motStatus: "Valid",
      taxStatus: "Taxed",
      taxDueDate: "2027-04-01",
    });
    expect(facts.sources).toEqual(["dvla", "dvsa", "vdg"]);
    expect(facts.mot?.lastMileage).toBe(84213);
  });

  it("uses DVSA's model when VDG was not needed", () => {
    const facts = mergeVehicleFacts({ dvla: dvlaAstra, dvsa: dvsaAstra }, TODAY);
    expect(facts.vehicle).toMatchObject({ make: "Vauxhall", model: "Astra", motExpiry: "2027-03-22" });
    expect(facts.vehicle.derivative).toBeUndefined();
  });

  it("falls back to DVLA's expiry and status without DVSA", () => {
    const facts = mergeVehicleFacts({ dvla: { ...dvlaAstra, motExpiry: "2026-12-01", motStatus: "Valid" } }, TODAY);
    expect(facts.vehicle).toMatchObject({ motExpiry: "2026-12-01", motStatus: "Valid" });
    expect(facts.mot).toBeUndefined();
  });

  it("marks an expired MOT as not valid from DVSA's history", () => {
    const facts = mergeVehicleFacts({ dvla: { ...dvlaAstra, motStatus: "Valid" }, dvsa: dvsaAstra }, "2027-03-23");
    expect(facts.vehicle.motStatus).toBe("Not valid");
    expect(mergeVehicleFacts({ dvsa: dvsaAstra }, "2027-03-22").vehicle.motStatus).toBe("Valid");
  });

  it("uses the first MOT due date for a vehicle too new for an MOT and keeps DVLA's label", () => {
    const facts = mergeVehicleFacts({
      dvla: { registration: "AB74CDE", make: "Kia", motStatus: "No details held by DVLA" },
      dvsa: parseDvsaVehicle(dvsaNewFixture),
    }, TODAY);
    expect(facts.vehicle).toMatchObject({ make: "Kia", model: "Niro", motExpiry: "2027-09-13", motStatus: "No details held by DVLA" });
    expect(facts.mot).toEqual({ motExpiry: "2027-09-13", motTestDueDate: "2027-09-13", motTests: [] });
  });

  it("never includes the registration in the facts", () => {
    const facts = mergeVehicleFacts({ dvla: dvlaAstra, dvsa: dvsaAstra, vdg: vdgAstra }, TODAY);
    expect(facts.vehicle).not.toHaveProperty("registration");
    expect(JSON.stringify(facts)).not.toContain(REG);
  });
});

describe("composite lookup", () => {
  it("calls DVLA and DVSA in parallel", async () => {
    let releaseDvla: (value: VehicleDetails) => void = () => undefined;
    const dvla = { lookup: vi.fn(() => new Promise<VehicleDetails>((resolve) => { releaseDvla = resolve; })) };
    const dvsa = dvsaSource(dvsaAstra);
    const pending = composite({ dvla, dvsa }).lookup(REG);
    await vi.waitFor(() => expect(dvsa.getMotHistory).toHaveBeenCalledTimes(1));
    expect(dvla.lookup).toHaveBeenCalledTimes(1);
    releaseDvla(dvlaAstra);
    await expect(pending).resolves.toMatchObject({ registration: REG, make: "Vauxhall", model: "Astra" });
  });

  it("does not call VDG when DVLA and DVSA give make and model", async () => {
    const vdg = source(vdgAstra);
    const vehicle = await composite({ dvla: source(dvlaAstra), dvsa: dvsaSource(dvsaAstra), vdg }).lookup(REG);
    expect(vdg.lookup).not.toHaveBeenCalled();
    expect(vehicle).toEqual({
      registration: REG,
      make: "Vauxhall",
      model: "Astra",
      year: 2012,
      colour: "Blue",
      fuelType: "Petrol",
      engineCapacityCc: 1398,
      motStatus: "Valid",
      motExpiry: "2027-03-22",
      taxStatus: "Taxed",
      taxDueDate: "2027-04-01",
    });
  });

  it("calls VDG only when the model is still missing", async () => {
    const vdg = source(vdgAstra);
    const provider = composite({ dvla: source(dvlaAstra), dvsa: dvsaSource(vehicleLookupError("not_found", { source: "dvsa" })), vdg });
    const result = await provider.lookupFacts(REG);
    expect(vdg.lookup).toHaveBeenCalledTimes(1);
    expect(vdg.lookup).toHaveBeenCalledWith(REG);
    expect(result.vehicle).toMatchObject({ make: "Vauxhall", model: "Astra", derivative: "Sri", motExpiry: "2027-03-22" });
    expect(result.sources).toEqual(["dvla", "vdg"]);
  });

  it("falls back to VDG alone when DVLA and DVSA both fail", async () => {
    const vdg = source(vdgAstra);
    const vehicle = await composite({
      dvla: source(vehicleLookupError("unavailable", { source: "dvla" })),
      dvsa: dvsaSource(vehicleLookupError("rate_limited", { source: "dvsa" })),
      vdg,
    }).lookup(REG);
    expect(vehicle).toMatchObject({ registration: REG, make: "Vauxhall", model: "Astra", derivative: "Sri" });
  });

  it("returns not_found (enter the car by hand) when every source fails", async () => {
    const provider = composite({
      dvla: source(vehicleLookupError("rate_limited", { source: "dvla" })),
      dvsa: dvsaSource(vehicleLookupError("unavailable", { source: "dvsa" })),
      vdg: source(vehicleLookupError("not_found", { source: "vdg" })),
    });
    const error = await provider.lookup(REG).then(
      () => { throw new Error("expected the lookup to fail"); },
      (caught: unknown) => caught as VehicleLookupError,
    );
    expect(error).toBeInstanceOf(VehicleLookupError);
    expect(error).toMatchObject({ code: "not_found", source: "composite", sourceErrors: { dvla: "rate_limited", dvsa: "unavailable", vdg: "not_found" } });
    expect(error.message).toBe("Vehicle not found");
  });

  it("returns invalid when every source rejects the registration", async () => {
    const provider = composite({
      dvla: source(vehicleLookupError("invalid", { source: "dvla" })),
      dvsa: dvsaSource(vehicleLookupError("invalid", { source: "dvsa" })),
    });
    await expect(provider.lookup(REG)).rejects.toMatchObject({ code: "invalid" });
  });

  it("treats an unexpected source exception as a failed source", async () => {
    const dvla = { lookup: vi.fn(() => { throw new Error(`boom ${REG}`); }) };
    const vehicle = await composite({ dvla, dvsa: dvsaSource(dvsaAstra) }).lookup(REG);
    expect(vehicle).toMatchObject({ make: "Vauxhall", model: "Astra" });
  });

  it("rejects a malformed registration without calling any source", async () => {
    const dvla = source(dvlaAstra);
    await expect(composite({ dvla }).lookup("??")).rejects.toMatchObject({ code: "invalid" });
    expect(dvla.lookup).not.toHaveBeenCalled();
  });

  it("shares one upstream lookup between concurrent requests for the same vehicle", async () => {
    const dvla = source(dvlaAstra);
    const dvsa = dvsaSource(dvsaAstra);
    const provider = composite({ dvla, dvsa });
    const [first, second] = await Promise.all([provider.lookup(REG), provider.lookup("ab12 cde")]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(dvla.lookup).toHaveBeenCalledTimes(1);
    expect(dvsa.getMotHistory).toHaveBeenCalledTimes(1);
  });

  it("passes MOT fields through; callers decide visibility", async () => {
    const result = await composite({ dvla: source(dvlaAstra), dvsa: dvsaSource(dvsaAstra) }).lookupFacts(REG);
    expect(result.vehicle).toMatchObject({ motStatus: "Valid", motExpiry: "2027-03-22" });
    expect(result.mot).toMatchObject({ lastMotTestDate: "2026-03-14", lastMileage: 84213, mileageUnit: "mi" });
    expect(result.mot?.motTests).toHaveLength(4);
  });
});

describe("vehicle facts cache in the composite", () => {
  it("misses, fetches, then serves a hit without calling the sources", async () => {
    const clock = fakeClock();
    const cache = spyCache();
    const dvla = source(dvlaAstra);
    const dvsa = dvsaSource(dvsaAstra);
    const provider = composite({ dvla, dvsa, cache, pepper: PEPPER }, clock);

    const miss = await provider.lookupFacts(REG);
    expect(miss.cached).toBe(false);
    expect(cache.set).toHaveBeenCalledTimes(1);

    clock.advance(23 * 60 * 60 * 1000);
    const hit = await provider.lookupFacts("ab12cde");
    expect(hit.cached).toBe(true);
    expect(hit.vehicle).toEqual(miss.vehicle);
    expect(hit.fetchedAt).toBe(miss.fetchedAt);
    expect(dvla.lookup).toHaveBeenCalledTimes(1);
    expect(dvsa.getMotHistory).toHaveBeenCalledTimes(1);
  });

  it("refetches and overwrites facts older than 24 hours", async () => {
    const clock = fakeClock();
    const cache = spyCache();
    const dvla = source(dvlaAstra);
    const provider = composite({ dvla, dvsa: dvsaSource(dvsaAstra), cache, pepper: PEPPER }, clock);

    await provider.lookup(REG);
    clock.advance(24 * 60 * 60 * 1000);
    const stale = await provider.lookupFacts(REG);
    expect(stale.cached).toBe(false);
    expect(dvla.lookup).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledTimes(2);
    expect(cache.set.mock.calls[1]?.[2]).toEqual(clock.date());
  });

  it("keys the cache by HMAC of the normalised registration and stores vehicle facts only", async () => {
    const cache = spyCache();
    await composite({ dvla: source(dvlaAstra), dvsa: dvsaSource(dvsaAstra), vdg: source(vdgAstra), cache, pepper: PEPPER }).lookup("ab12 cde");

    const [regHash, facts] = cache.set.mock.calls[0] ?? [];
    expect(regHash).toBe(hashRegistration(REG, PEPPER));
    expect(regHash).toMatch(/^[0-9a-f]{64}$/);
    for (const call of [...cache.get.mock.calls, ...cache.set.mock.calls]) {
      const seen = JSON.stringify(call);
      expect(seen).not.toContain(REG);
      expect(seen).not.toContain("AB12 CDE");
      expect(seen.toLowerCase()).not.toContain("ab12cde");
    }
    expect(Object.keys(facts ?? {}).sort()).toEqual(["mot", "sources", "vehicle", "version"]);
    expect(facts?.vehicle).not.toHaveProperty("registration");
    for (const key of ["name", "email", "phone", "mobile", "customer", "garageId", "garage_id", "bookingId", "vin", "postcode"]) {
      expect(JSON.stringify(facts)).not.toContain(`"${key}"`);
    }
  });

  it("does not cache an answer while a source is failing transiently", async () => {
    const cache = spyCache();
    const provider = composite({ dvla: source(dvlaAstra), dvsa: dvsaSource(vehicleLookupError("rate_limited", { source: "dvsa" })), cache, pepper: PEPPER });
    await expect(provider.lookup(REG)).resolves.toMatchObject({ make: "Vauxhall" });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("caches an answer when the other source simply has no record", async () => {
    const cache = spyCache();
    const provider = composite({ dvla: source(dvlaAstra), dvsa: dvsaSource(vehicleLookupError("not_found", { source: "dvsa" })), cache, pepper: PEPPER });
    await provider.lookup(REG);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("keeps working when the cache throws", async () => {
    const logger = { warn: vi.fn() };
    const broken: VehicleFactsCache = {
      get: vi.fn(async () => { throw new Error(`db down ${REG}`); }),
      set: vi.fn(async () => { throw new Error(`db down ${REG}`); }),
    };
    const vehicle = await composite({ dvla: source(dvlaAstra), dvsa: dvsaSource(dvsaAstra), cache: broken, pepper: PEPPER, logger }).lookup(REG);
    expect(vehicle).toMatchObject({ make: "Vauxhall" });
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(REG);
  });

  it("ignores a cached row that does not match the facts shape", async () => {
    const dvla = source(dvlaAstra);
    const weird: VehicleFactsCache = {
      get: async () => ({ facts: { version: 2, vehicle: {} } as unknown as VehicleFacts, fetchedAt: new Date("2026-10-26T08:00:00.000Z") }),
      set: async () => undefined,
    };
    await composite({ dvla, cache: weird, pepper: PEPPER }).lookup(REG);
    expect(dvla.lookup).toHaveBeenCalledTimes(1);
  });

  it("skips the cache without a pepper", async () => {
    const cache = spyCache();
    await composite({ dvla: source(dvlaAstra), cache }).lookup(REG);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe("privacy", () => {
  it("never logs the registration and never puts it in a thrown error", async () => {
    const logger = { warn: vi.fn() };
    const provider = createCompositeProvider({
      dvla: source(vehicleLookupError("unavailable", { source: "dvla", status: 503 })),
      dvsa: dvsaSource(vehicleLookupError("rate_limited", { source: "dvsa", status: 429, upstreamCode: "MOTH-RL-02" })),
      vdg: source(vehicleLookupError("not_found", { source: "vdg" })),
      logger,
    });
    const error = await provider.lookup("ab12 cde").catch((caught: unknown) => caught);
    const text = describeError(error);
    expect(text).not.toContain(REG);
    expect(text).not.toContain("AB12 CDE");
    expect(text.toLowerCase()).not.toContain("ab12");
    expect(logger.warn).toHaveBeenCalledWith("[vehicle] source lookup failed", expect.objectContaining({ source: "dvla", code: "unavailable", status: 503 }));
    expect(JSON.stringify(logger.warn.mock.calls).toLowerCase()).not.toContain("ab12");
  });
});

describe("composite with the real clients and recorded fixtures", () => {
  const dvsaCredentials = {
    clientId: "00000000-0000-4000-8000-000000000001",
    clientSecret: "fake-dvsa-client-secret-for-tests-only",
    apiKey: "fake-dvsa-api-key-for-tests-only",
    tokenUrl: "https://login.microsoftonline.com/00000000-0000-4000-8000-0000000000aa/oauth2/v2.0/token",
  };

  function wired(routes: { dvla: Record<string, Response>; dvsa: Record<string, Response>; vdg?: Record<string, Response> }) {
    const http = fakeFetch((call) => {
      if (call.url === dvsaCredentials.tokenUrl) return json(200, dvsaToken);
      if (call.url.startsWith("https://driver-vehicle-licensing.api.gov.uk/")) {
        const reg = (JSON.parse(String(call.init.body)) as { registrationNumber: string }).registrationNumber;
        return routes.dvla[reg]?.clone() ?? json(404, dvlaErrors.notFound);
      }
      if (call.url.startsWith("https://history.mot.api.gov.uk/")) {
        const reg = decodeURIComponent(call.url.split("/").at(-1) ?? "");
        return routes.dvsa[reg]?.clone() ?? json(404, dvsaErrors.notFound);
      }
      if (call.url.startsWith("https://uk.api.vehicledataglobal.com/")) {
        const reg = new URL(call.url).searchParams.get("Vrm") ?? "";
        return routes.vdg?.[reg]?.clone() ?? json(404, {});
      }
      return new Error("unexpected host");
    });
    const clock = fakeClock();
    const provider = createCompositeProvider({
      dvla: new DvlaProvider({ apiKey: "fake-dvla-key", fetch: http.fetch, now: clock.now }),
      dvsa: new DvsaMotHistoryClient({ ...dvsaCredentials, fetch: http.fetch, now: clock.now, rateLimit: false }),
      vdg: new VehicleDataGlobalProvider("fake-vdg-key", "https://uk.api.vehicledataglobal.com", "VehicleDetails", 6500, http.fetch),
      cache: createMemoryVehicleFactsCache(),
      pepper: PEPPER,
      now: clock.date,
      logger: silent,
    });
    return { provider, http };
  }

  it("merges DVLA and DVSA for a tested vehicle without paying for VDG", async () => {
    const { provider, http } = wired({
      dvla: { AB12CDE: json(200, dvlaFixture) },
      dvsa: { AB12CDE: json(200, dvsaFixture) },
      vdg: { AB12CDE: json(200, vdgFixture) },
    });
    const result = await provider.lookupFacts("AB12 CDE");
    expect(result.vehicle).toMatchObject({ registration: REG, make: "Vauxhall", model: "Astra", colour: "Blue", motExpiry: "2027-03-22", motStatus: "Valid", taxStatus: "Taxed" });
    expect(result.sources).toEqual(["dvla", "dvsa"]);
    expect(http.calls.some((call) => call.url.includes("vehicledataglobal"))).toBe(false);
  });

  it("handles a vehicle too new for an MOT", async () => {
    const { provider } = wired({
      dvla: { AB74CDE: json(200, dvlaNewFixture) },
      dvsa: { AB74CDE: json(200, dvsaNewFixture) },
    });
    const result = await provider.lookupFacts("AB74CDE");
    expect(result.vehicle).toMatchObject({ make: "Kia", model: "Niro", fuelType: "Electricity", motExpiry: "2027-09-13", motStatus: "No details held by DVLA" });
    expect(result.mot?.motTests).toEqual([]);
  });

  it("pays for VDG when DVSA has no record and DVLA has no model", async () => {
    const { provider, http } = wired({
      dvla: { AB12CDE: json(200, dvlaFixture) },
      dvsa: {},
      vdg: { AB12CDE: json(200, vdgFixture) },
    });
    const vehicle = await provider.lookup(REG);
    expect(vehicle).toMatchObject({ make: "Vauxhall", model: "Astra", derivative: "Sri", transmission: "Manual", motExpiry: "2027-03-22" });
    expect(http.calls.filter((call) => call.url.includes("vehicledataglobal"))).toHaveLength(1);
  });

  it("returns not_found when no source knows the vehicle", async () => {
    const { provider } = wired({ dvla: {}, dvsa: {}, vdg: {} });
    await expect(provider.lookup("ZZ99ZZZ")).rejects.toMatchObject({ code: "not_found" });
  });
});
