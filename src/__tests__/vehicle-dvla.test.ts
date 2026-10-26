import { describe, expect, it } from "vitest";
import { DVLA_VES_BASE_URLS, DvlaProvider } from "@/lib/vehicle/dvla";
import { VehicleLookupError } from "@/lib/vehicle/provider";
import success from "./fixtures/vehicle/dvla-ab12cde.json";
import newVehicle from "./fixtures/vehicle/dvla-ab74cde-new.json";
import uatBlankDates from "./fixtures/vehicle/dvla-uat-blank-dates.json";
import errors from "./fixtures/vehicle/dvla-errors.json";
import { describeError, fakeClock, fakeFetch, header, json, queuedFetch } from "./fixtures/vehicle/fake-http";

const apiKey = "fake-dvla-key-for-tests-only";

function client(fetchImpl: typeof fetch, clock = fakeClock(), environment?: "live" | "uat") {
  return new DvlaProvider({ apiKey, fetch: fetchImpl, now: clock.now, environment, correlationId: () => "test-correlation-id" });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as VehicleLookupError;
  }
  throw new Error("expected the lookup to fail");
}

describe("DVLA VES client", () => {
  it("posts the registration to the live endpoint with the API key header", async () => {
    const http = queuedFetch(json(200, success));
    await client(http.fetch).lookup("ab12 cde");

    const [call] = http.calls;
    expect(call?.url).toBe("https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles");
    expect(call?.init.method).toBe("POST");
    expect(header(call, "x-api-key")).toBe(apiKey);
    expect(header(call, "content-type")).toBe("application/json");
    expect(header(call, "x-correlation-id")).toBe("test-correlation-id");
    expect(JSON.parse(String(call?.init.body))).toEqual({ registrationNumber: "AB12CDE" });
  });

  it("uses DVLA's UAT environment when asked", async () => {
    const http = queuedFetch(json(200, uatBlankDates));
    await client(http.fetch, fakeClock(), "uat").lookup("AA19PPP");
    expect(http.calls[0]?.url).toBe(`${DVLA_VES_BASE_URLS.uat}/v1/vehicles`);
    expect(DVLA_VES_BASE_URLS.uat).toBe("https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry");
  });

  it("maps make, colour, fuel, year, engine size, MOT and tax from a recorded response", async () => {
    const vehicle = await client(queuedFetch(json(200, success)).fetch).lookup("AB12CDE");
    expect(vehicle).toEqual({
      registration: "AB12CDE",
      make: "Vauxhall",
      year: 2012,
      colour: "Blue",
      fuelType: "Petrol",
      engineCapacityCc: 1398,
      motStatus: "Valid",
      motExpiry: "2027-03-22",
      taxStatus: "Taxed",
      taxDueDate: "2027-04-01",
    });
    for (const discarded of ["markedForExport", "dateOfLastV5CIssued", "co2Emissions", "wheelplan", "revenueWeight", "euroStatus"]) {
      expect(vehicle).not.toHaveProperty(discarded);
    }
  });

  it("keeps DVLA's own MOT label for a vehicle too new for an MOT", async () => {
    const vehicle = await client(queuedFetch(json(200, newVehicle)).fetch).lookup("AB74CDE");
    expect(vehicle).toMatchObject({ make: "Kia", fuelType: "Electricity", motStatus: "No details held by DVLA" });
    expect(vehicle.motExpiry).toBeUndefined();
    expect(vehicle.engineCapacityCc).toBeUndefined();
  });

  it("treats DVLA's empty date strings as absent", async () => {
    const vehicle = await client(queuedFetch(json(200, uatBlankDates)).fetch).lookup("AA19PPP");
    expect(vehicle.motStatus).toBe("Valid");
    expect(vehicle.motExpiry).toBeUndefined();
    expect(vehicle.taxDueDate).toBeUndefined();
  });

  it("maps 404 to not_found", async () => {
    const error = await rejection(client(queuedFetch(json(404, errors.notFound)).fetch).lookup("AB12CDE"));
    expect(error).toBeInstanceOf(VehicleLookupError);
    expect(error).toMatchObject({ code: "not_found", source: "dvla", status: 404, upstreamCode: "404" });
  });

  it("maps 400 to invalid", async () => {
    const error = await rejection(client(queuedFetch(json(400, errors.badRequest)).fetch).lookup("AB12CDE"));
    expect(error).toMatchObject({ code: "invalid", status: 400, upstreamCode: "400" });
  });

  it("maps 429 to rate_limited and cools down before calling DVLA again", async () => {
    const clock = fakeClock();
    const http = queuedFetch(json(429, errors.rateLimited), json(200, success));
    const dvla = client(http.fetch, clock);

    const first = await rejection(dvla.lookup("AB12CDE"));
    expect(first).toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: 1000 });

    const second = await rejection(dvla.lookup("AB12CDE"));
    expect(second.code).toBe("rate_limited");
    expect(http.calls).toHaveLength(1);

    clock.advance(1000);
    await expect(dvla.lookup("AB12CDE")).resolves.toMatchObject({ make: "Vauxhall" });
    expect(http.calls).toHaveLength(2);
  });

  it("honours Retry-After on a 429, including the collective limit", async () => {
    const clock = fakeClock();
    const error = await rejection(client(queuedFetch(json(429, errors.collectiveRateLimited, { "Retry-After": "7" })).fetch, clock).lookup("AB12CDE"));
    expect(error.retryAfterMs).toBe(7000);
  });

  it.each([
    [403, errors.forbidden],
    [500, errors.internalError],
    [502, { message: "Internal server error" }],
    [503, errors.maintenance],
    [504, { message: "Gateway Timeout" }],
  ])("maps HTTP %s to unavailable", async (status, body) => {
    const error = await rejection(client(queuedFetch(json(status, body)).fetch).lookup("AB12CDE"));
    expect(error).toMatchObject({ code: "unavailable", status });
  });

  it("maps a network failure or timeout to unavailable", async () => {
    const error = await rejection(client(queuedFetch(new TypeError("fetch failed: https://example.invalid/AB12CDE")).fetch).lookup("AB12CDE"));
    expect(error).toMatchObject({ code: "unavailable", source: "dvla" });
    expect(error.status).toBeUndefined();
  });

  it("rejects a malformed registration without calling DVLA", async () => {
    const http = fakeFetch(() => json(200, success));
    const error = await rejection(client(http.fetch).lookup("!"));
    expect(error.code).toBe("invalid");
    expect(http.calls).toHaveLength(0);
  });

  it("never puts the registration or the key in an error", async () => {
    const replies = [
      json(404, errors.notFound),
      json(400, errors.badRequest),
      json(429, errors.rateLimited),
      json(503, errors.maintenance),
      new TypeError("request to https://driver-vehicle-licensing.api.gov.uk failed for AB12CDE"),
    ];
    for (const reply of replies) {
      const error = await rejection(client(queuedFetch(reply).fetch).lookup("AB12CDE"));
      const text = describeError(error);
      expect(text).not.toContain("AB12CDE");
      expect(text).not.toContain("AB12 CDE");
      expect(text).not.toContain(apiKey);
    }
  });

  it("refuses to start without an API key", () => {
    expect(() => new DvlaProvider({ apiKey: "" })).toThrow(/configuration required/i);
  });
});
