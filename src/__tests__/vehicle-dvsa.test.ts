import { describe, expect, it } from "vitest";
import {
  DVSA_MOT_DEFAULT_SCOPE,
  DvsaMotHistoryClient,
  londonIsoDate,
  parseDvsaVehicle,
  type DvsaClientOptions,
} from "@/lib/vehicle/dvsa";
import { createTokenBucket } from "@/lib/vehicle/http";
import { VehicleLookupError } from "@/lib/vehicle/provider";
import history from "./fixtures/vehicle/dvsa-ab12cde.json";
import newVehicle from "./fixtures/vehicle/dvsa-ab74cde-new.json";
import errors from "./fixtures/vehicle/dvsa-errors.json";
import token from "./fixtures/vehicle/dvsa-token.json";
import { describeError, fakeClock, fakeFetch, formOf, header, json, type FetchCall } from "./fixtures/vehicle/fake-http";

const credentials = {
  clientId: "00000000-0000-4000-8000-000000000001",
  clientSecret: "fake-dvsa-client-secret-for-tests-only",
  apiKey: "fake-dvsa-api-key-for-tests-only",
  tokenUrl: "https://login.microsoftonline.com/00000000-0000-4000-8000-0000000000aa/oauth2/v2.0/token",
};

const TOKEN_URL = credentials.tokenUrl;
const API = "https://history.mot.api.gov.uk/v1/trade/vehicles/registration/";

type Handler = (call: FetchCall) => Response | Error;

/** Routes token requests and API requests separately; counts each. */
function dvsaHttp(api: Handler, tokenReply: () => Response = () => json(200, token)) {
  let tokens = 0;
  let lookups = 0;
  const http = fakeFetch((call) => {
    if (call.url === TOKEN_URL) {
      tokens += 1;
      return tokenReply();
    }
    lookups += 1;
    return api(call);
  });
  return { ...http, tokenRequests: () => tokens, lookupRequests: () => lookups };
}

function client(http: { fetch: typeof fetch }, clock = fakeClock(), extra: Partial<DvsaClientOptions> = {}) {
  return new DvsaMotHistoryClient({ ...credentials, fetch: http.fetch, now: clock.now, rateLimit: false, ...extra });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as VehicleLookupError;
  }
  throw new Error("expected the lookup to fail");
}

describe("DVSA token (OAuth2 client credentials)", () => {
  it("requests a client-credentials token with the documented scope", async () => {
    const http = dvsaHttp(() => json(200, history));
    await client(http).getMotHistory("AB12CDE");

    const tokenCall = http.calls.find((call) => call.url === TOKEN_URL);
    expect(tokenCall?.init.method).toBe("POST");
    expect(header(tokenCall, "content-type")).toBe("application/x-www-form-urlencoded");
    expect(formOf(tokenCall)).toEqual({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: DVSA_MOT_DEFAULT_SCOPE,
    });
    expect(DVSA_MOT_DEFAULT_SCOPE).toBe("https://tapi.dvsa.gov.uk/.default");
  });

  it("sends the bearer token and API key to the v1 registration endpoint", async () => {
    const http = dvsaHttp(() => json(200, history));
    await client(http).getMotHistory("ab12 cde");

    const apiCall = http.calls.find((call) => call.url.startsWith(API));
    expect(apiCall?.url).toBe(`${API}AB12CDE`);
    expect(apiCall?.init.method).toBe("GET");
    expect(header(apiCall, "authorization")).toBe(`Bearer ${token.access_token}`);
    expect(header(apiCall, "x-api-key")).toBe(credentials.apiKey);
  });

  it("caches the token until shortly before it expires", async () => {
    const clock = fakeClock();
    const http = dvsaHttp(() => json(200, history));
    const dvsa = client(http, clock);

    await dvsa.getMotHistory("AB12CDE");
    clock.advance((token.expires_in - 61) * 1000);
    await dvsa.getMotHistory("AB12CDE");
    expect(http.tokenRequests()).toBe(1);

    // Inside the one-minute refresh window: fetch a new token.
    clock.advance(2000);
    await dvsa.getMotHistory("AB12CDE");
    expect(http.tokenRequests()).toBe(2);
    expect(http.lookupRequests()).toBe(3);
  });

  it("shares one token request between concurrent lookups", async () => {
    const http = dvsaHttp(() => json(200, history));
    const dvsa = client(http);
    await Promise.all([dvsa.getMotHistory("AB12CDE"), dvsa.getMotHistory("AB74CDE"), dvsa.getMotHistory("CD34EFG")]);
    expect(http.tokenRequests()).toBe(1);
    expect(http.lookupRequests()).toBe(3);
  });

  it("refreshes the token and retries once when DVSA reports it expired", async () => {
    let calls = 0;
    const http = dvsaHttp(() => (++calls === 1 ? json(403, errors.tokenExpired) : json(200, history)));
    const result = await client(http).getMotHistory("AB12CDE");
    expect(result.mot.motExpiry).toBe("2027-03-22");
    expect(http.tokenRequests()).toBe(2);
    expect(http.lookupRequests()).toBe(2);
  });

  it("retries a 401 once, then gives up as unavailable", async () => {
    const http = dvsaHttp(() => json(401, { errorCode: "MOTH-UA-01", errorMessage: "Unauthorised" }));
    const error = await rejection(client(http).getMotHistory("AB12CDE"));
    expect(error).toMatchObject({ code: "unavailable", status: 401, upstreamCode: "MOTH-UA-01" });
    expect(http.lookupRequests()).toBe(2);
  });

  it("fails closed when Entra rejects the client, without exposing the secret", async () => {
    const http = dvsaHttp(() => json(200, history), () => json(401, errors.tokenInvalidClient));
    const error = await rejection(client(http).getMotHistory("AB12CDE"));
    expect(error).toMatchObject({ code: "unavailable", source: "dvsa", status: 401, upstreamCode: "invalid_client" });
    expect(http.lookupRequests()).toBe(0);
    const text = describeError(error);
    expect(text).not.toContain(credentials.clientSecret);
    expect(text).not.toContain("AADSTS");
  });

  it("refuses to start without credentials or with a non-https token URL, naming only the variable", () => {
    expect(() => new DvsaMotHistoryClient({ ...credentials, clientSecret: "" })).toThrow(/DVSA_MOT_CLIENT_SECRET/);
    const error = (() => {
      try {
        new DvsaMotHistoryClient({ ...credentials, tokenUrl: "http://login.example.test/token" });
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).toMatch(/DVSA_MOT_TOKEN_URL/);
    expect(error?.message).not.toContain("login.example.test");
  });
});

describe("DVSA MOT history parsing", () => {
  it("summarises a vehicle with MOT tests", () => {
    const vehicle = parseDvsaVehicle(history);
    expect(vehicle).toMatchObject({
      make: "Vauxhall",
      model: "Astra",
      colour: "Blue",
      fuelType: "Petrol",
      engineCapacityCc: 1398,
      year: 2012,
    });
    expect(vehicle.mot).toMatchObject({
      motExpiry: "2027-03-22",
      lastMotTestDate: "2026-03-14",
      lastMileage: 84213,
      mileageUnit: "mi",
    });
    expect(vehicle.mot.motTestDueDate).toBeUndefined();
    expect(vehicle.mot.motTests).toHaveLength(4);
    expect(vehicle.mot.motTests[0]).toEqual({
      completedDate: "2026-03-14T10:42:17.000Z",
      result: "passed",
      expiryDate: "2027-03-22",
      odometer: { value: 84213, unit: "mi" },
      defects: [
        { type: "advisory", text: "Nearside Front Tyre worn close to legal limit/worn on edge (5.2.3 (e))", dangerous: false },
        { type: "advisory", text: "Front Brake disc worn, pitted or scored, but not seriously weakened (1.1.14 (a) (ii))", dangerous: false },
      ],
    });
    expect(vehicle.mot.motTests[1]).toMatchObject({ result: "failed", odometer: { value: 84190, unit: "mi" } });
    expect(vehicle.mot.motTests[1]?.expiryDate).toBeUndefined();
    expect(vehicle.mot.motTests[1]?.defects.map((defect) => defect.type)).toEqual(["major", "dangerous", "minor"]);
    // An unreadable odometer is left out rather than guessed.
    expect(vehicle.mot.motTests[3]?.odometer).toBeUndefined();
  });

  it("discards registrations and test identifiers from the upstream body", () => {
    const text = JSON.stringify(parseDvsaVehicle(history));
    expect(text).not.toContain("AB12CDE");
    expect(text).not.toContain("registrationAtTimeOfTest");
    expect(text).not.toContain("512345678901");
    expect(text).not.toContain("hasOutstandingRecall");
  });

  it("handles a vehicle too new for an MOT (due date only)", () => {
    const vehicle = parseDvsaVehicle(newVehicle);
    expect(vehicle).toMatchObject({ make: "Kia", model: "Niro", colour: "White", fuelType: "Electric", year: 2024 });
    expect(vehicle.mot).toEqual({ motExpiry: "2027-09-13", motTestDueDate: "2027-09-13", motTests: [] });
  });

  it("sorts tests newest first and takes the latest passed expiry", () => {
    const shuffled = { ...history, motTests: [...history.motTests].reverse() };
    const vehicle = parseDvsaVehicle(shuffled);
    expect(vehicle.mot.motTests.map((test) => test.completedDate.slice(0, 10))).toEqual(["2026-03-14", "2026-03-10", "2025-03-18", "2024-03-20"]);
    expect(vehicle.mot.motExpiry).toBe("2027-03-22");
  });

  it("leaves the expiry empty when every test failed", () => {
    const failedOnly = { make: "FORD", motTests: [{ completedDate: "2026-01-05T10:00:00.000Z", testResult: "FAILED", odometerValue: "1200", odometerUnit: "KM", odometerResultType: "READ", dataSource: "DVSA", defects: null }] };
    const vehicle = parseDvsaVehicle(failedOnly);
    expect(vehicle.mot.motExpiry).toBeUndefined();
    expect(vehicle.mot).toMatchObject({ lastMileage: 1200, mileageUnit: "km", lastMotTestDate: "2026-01-05" });
  });

  it("dates the last test in Europe/London across the clock change", () => {
    // 23:30 UTC on 30 June is 00:30 BST on 1 July.
    expect(londonIsoDate(new Date("2025-06-30T23:30:00.000Z"))).toBe("2025-07-01");
    // 23:30 UTC on 30 December is still 30 December in GMT.
    expect(londonIsoDate(new Date("2025-12-30T23:30:00.000Z"))).toBe("2025-12-30");
    // Clocks went back at 01:00 UTC on 26 October 2025.
    expect(londonIsoDate(new Date("2025-10-25T23:30:00.000Z"))).toBe("2025-10-26");
    expect(londonIsoDate(new Date("2025-10-26T23:30:00.000Z"))).toBe("2025-10-26");
  });

  it("ignores malformed tests and unknown defect types", () => {
    const vehicle = parseDvsaVehicle({
      motTests: [
        { completedDate: "not a date", testResult: "PASSED" },
        { completedDate: "2026-02-01T09:00:00.000Z", testResult: "ABANDONED" },
        { completedDate: "2026-02-02T09:00:00.000Z", testResult: "PASSED", expiryDate: "2027-02-30", defects: [{ text: "  Wiper   blade  deteriorated ", type: "SOMETHING NEW" }, { text: "", type: "MINOR" }] },
      ],
    });
    expect(vehicle.mot.motTests).toHaveLength(1);
    expect(vehicle.mot.motTests[0]?.expiryDate).toBeUndefined();
    expect(vehicle.mot.motTests[0]?.defects).toEqual([{ type: "unknown", text: "Wiper blade deteriorated" }]);
  });
});

describe("DVSA lookup errors", () => {
  it("maps 404 MOTH-NF-01 to not_found", async () => {
    const error = await rejection(client(dvsaHttp(() => json(404, errors.notFound))).getMotHistory("AB12CDE"));
    expect(error).toMatchObject({ code: "not_found", source: "dvsa", status: 404, upstreamCode: "MOTH-NF-01" });
  });

  it("treats 404 MOTH-NF-02 (URL not found) as unavailable, not as a missing vehicle", async () => {
    const error = await rejection(client(dvsaHttp(() => json(404, errors.urlNotFound))).getMotHistory("AB12CDE"));
    expect(error).toMatchObject({ code: "unavailable", upstreamCode: "MOTH-NF-02" });
  });

  it("maps 400 to invalid", async () => {
    const error = await rejection(client(dvsaHttp(() => json(400, errors.badRequest))).getMotHistory("AB12CDE"));
    expect(error).toMatchObject({ code: "invalid", upstreamCode: "MOTH-IV-03" });
  });

  it("maps 403 MOTH-FB-03 and 500 to unavailable", async () => {
    await expect(client(dvsaHttp(() => json(403, errors.apiKeyNotRecognised))).getMotHistory("AB12CDE")).rejects.toMatchObject({ code: "unavailable", upstreamCode: "MOTH-FB-03" });
    await expect(client(dvsaHttp(() => json(500, errors.unknown))).getMotHistory("AB12CDE")).rejects.toMatchObject({ code: "unavailable", status: 500 });
    await expect(client(dvsaHttp(() => new TypeError("fetch failed"))).getMotHistory("AB12CDE")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("backs off exponentially on repeated 429s and skips DVSA while cooling down", async () => {
    const clock = fakeClock();
    const http = dvsaHttp(() => json(429, errors.tooManyRequests));
    const dvsa = client(http, clock);

    const first = await rejection(dvsa.getMotHistory("AB12CDE"));
    expect(first).toMatchObject({ code: "rate_limited", status: 429, upstreamCode: "MOTH-RL-02", retryAfterMs: 1000 });

    const cooling = await rejection(dvsa.getMotHistory("AB12CDE"));
    expect(cooling).toMatchObject({ code: "rate_limited", retryAfterMs: 1000 });
    expect(http.lookupRequests()).toBe(1);

    clock.advance(1000);
    const second = await rejection(dvsa.getMotHistory("AB12CDE"));
    expect(second.retryAfterMs).toBe(2000);
    clock.advance(2000);
    const third = await rejection(dvsa.getMotHistory("AB12CDE"));
    expect(third.retryAfterMs).toBe(4000);
    expect(http.lookupRequests()).toBe(3);
  });

  it("resets the backoff after a success", async () => {
    const clock = fakeClock();
    let calls = 0;
    const replies = [429, 200, 429];
    const http = dvsaHttp(() => {
      const status = replies[calls++] ?? 200;
      return status === 200 ? json(200, history) : json(429, errors.tooManyRequests);
    });
    const dvsa = client(http, clock);
    await rejection(dvsa.getMotHistory("AB12CDE"));
    clock.advance(1000);
    await dvsa.getMotHistory("AB12CDE");
    const again = await rejection(dvsa.getMotHistory("AB12CDE"));
    expect(again.retryAfterMs).toBe(1000);
  });

  it("honours Retry-After and holds off for an hour after the daily quota is spent", async () => {
    const withHeader = await rejection(client(dvsaHttp(() => json(429, errors.tooManyRequests, { "Retry-After": "30" }))).getMotHistory("AB12CDE"));
    expect(withHeader.retryAfterMs).toBe(30_000);
    const quota = await rejection(client(dvsaHttp(() => json(429, errors.dailyQuota))).getMotHistory("AB12CDE"));
    expect(quota).toMatchObject({ upstreamCode: "MOTH-RL-01", retryAfterMs: 60 * 60 * 1000 });
  });

  it("never puts the registration, token or credentials in an error", async () => {
    const replies: Handler[] = [
      () => json(404, errors.notFound),
      () => json(400, errors.badRequest),
      () => json(429, errors.tooManyRequests),
      () => json(500, errors.unknown),
      () => new TypeError(`fetch failed for ${API}AB12CDE`),
    ];
    for (const reply of replies) {
      const error = await rejection(client(dvsaHttp(reply)).getMotHistory("AB12CDE"));
      const text = describeError(error);
      expect(text).not.toContain("AB12CDE");
      expect(text).not.toContain(token.access_token);
      expect(text).not.toContain(credentials.apiKey);
      expect(text).not.toContain(credentials.clientSecret);
    }
  });

  it("paces requests below DVSA's burst limit", async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    const bucket = createTokenBucket({
      ratePerSecond: 10,
      burst: 2,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
    });
    await Promise.all([bucket.take(), bucket.take(), bucket.take(), bucket.take()]);
    expect(sleeps).toEqual([100, 100]);
  });
});
