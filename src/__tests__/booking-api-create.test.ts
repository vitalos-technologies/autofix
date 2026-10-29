import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Garage } from "@/lib/tenancy/garage";
import { fakeEngine, jsonRequest } from "./support/booking-routes";
import { otherTestGarage, testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({
  garage: null as Garage | null,
  blockedScopes: new Set<string>(),
  rateLimitCalls: [] as Array<[string, string]>,
  turnstile: vi.fn(async () => true),
}));
vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => harness.garage) }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async (identifier: string, scope: string) => {
    harness.rateLimitCalls.push([identifier, scope]);
    return !harness.blockedScopes.has(scope);
  }),
}));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: harness.turnstile }));

import { POST } from "@/app/api/bookings/route";
import { setBookingEngineForTests } from "@/lib/booking-engine";

const garage = testGarage();
const other = otherTestGarage();
const engine = fakeEngine();
const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx";

const body = {
  serviceId: "33333333-3333-4333-8333-333333333333",
  startsAt: "2026-11-20T10:00:00.000Z",
  locationMode: "workshop",
  symptoms: ["Warning light"],
  customer: { name: "Sam Patel", phone: "07700 900123", email: "sam@example.com", channel: "sms", reminderConsent: true },
  vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
  idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
};

const created = {
  ok: true,
  replayed: false,
  booking: {
    id: "55555555-5555-4555-8555-555555555555",
    reference: "HRM-4821",
    status: "confirmed",
    startsAt: "2026-11-20T10:00:00.000Z",
    endsAt: "2026-11-20T11:00:00.000Z",
    customerId: "66666666-6666-4666-8666-666666666666",
    vehicleId: "77777777-7777-4777-8777-777777777777",
    manageToken: TOKEN,
  },
};

const post = (payload: unknown, init: Parameters<typeof jsonRequest>[2] = {}) => POST(jsonRequest("/api/bookings", payload, init));

describe("POST /api/bookings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.garage = garage;
    harness.blockedScopes = new Set();
    harness.rateLimitCalls = [];
    harness.turnstile.mockResolvedValue(true);
    engine.createBooking.mockResolvedValue(created);
    setBookingEngineForTests(engine);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => setBookingEngineForTests(null));

  it("201: creates the booking for the host's garage as an online booking", async () => {
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      booking: {
        reference: "HRM-4821",
        status: "confirmed",
        startsAt: "2026-11-20T10:00:00.000Z",
        endsAt: "2026-11-20T11:00:00.000Z",
        manageUrl: `http://hartley-road.localhost:3000/manage?token=${TOKEN}`,
      },
      replayed: false,
    });
    const [garageId, input] = engine.createBooking.mock.calls[0]!;
    expect(garageId).toBe(garage.id);
    expect(input).toMatchObject({ source: "online", serviceId: body.serviceId, vehicle: { registration: "AB12CDE" } });
    expect(input).not.toHaveProperty("turnstileToken");
    expect(input).not.toHaveProperty("reminderSendId");
  });

  it("never takes offers consent from the body: only the booking page records it", async () => {
    const response = await post({ ...body, customer: { ...body.customer, offersConsent: true, offersConsentText: "Send me occasional offers from Anyone. You can stop these any time." } });
    expect(response.status).toBe(201);
    const [, input] = engine.createBooking.mock.calls[0]!;
    expect(input.customer).toMatchObject({ reminderConsent: true, offersConsent: false });
    expect(input.customer).not.toHaveProperty("offersConsentText");
  });

  it("applies SOB's limits: per IP, per garage and per customer", async () => {
    await post(body);
    expect(harness.rateLimitCalls).toEqual([
      ["198.51.100.7", "booking_create_ip"],
      [garage.id, "booking_create_garage"],
      [`${garage.id}:198.51.100.7:+447700900123`, "booking_create_details"],
    ]);
  });

  it("200: an idempotent replay returns the same booking", async () => {
    engine.createBooking.mockResolvedValue({ ...created, replayed: true });
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: true, booking: { reference: "HRM-4821" } });
  });

  it("409: a lost slot comes back with the nearest alternatives", async () => {
    const alternatives = [{ startsAt: "2026-11-20T10:30:00.000Z", endsAt: "2026-11-20T11:30:00.000Z", freeCount: 1 }];
    engine.createBooking.mockResolvedValue({ ok: false, code: "SLOT_UNAVAILABLE", message: "That time has just been taken.", alternatives });
    const response = await post(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "SLOT_UNAVAILABLE", message: "That time has just been taken.", alternatives });
  });

  it("422: engine rejections for service, area and details", async () => {
    for (const code of ["SERVICE_UNAVAILABLE", "OUTSIDE_SERVICE_AREA", "INVALID_BOOKING"]) {
      engine.createBooking.mockResolvedValueOnce({ ok: false, code, message: "No" });
      const response = await post(body);
      expect(response.status, code).toBe(422);
      expect(await response.json()).toMatchObject({ code });
    }
  });

  it("503: engine outage", async () => {
    engine.createBooking.mockResolvedValue({ ok: false, code: "UNAVAILABLE", message: "Down" });
    const response = await post(body);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("422: a garage id, source or reminder attribution in the body is rejected, not used", async () => {
    for (const extra of [{ garageId: other.id }, { garage_id: other.id }, { source: "phone" }, { reminderSendId: "0e2a6a43-5f2c-4b7e-9c43-0a2c7c1a9d10" }]) {
      const response = await post({ ...body, ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(422);
      const json = await response.json();
      expect(json.code).toBe("INVALID_BOOKING");
      expect(JSON.stringify(json)).not.toContain(other.id);
    }
    expect(engine.createBooking).not.toHaveBeenCalled();
  });

  it("422: schema failures list fields without echoing what was typed", async () => {
    const response = await post({ ...body, vehicle: { registration: "!!" }, customer: { ...body.customer, name: "S" } });
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.issues.map((issue: { path: string }) => issue.path)).toEqual(expect.arrayContaining(["vehicle.registration", "customer.name"]));
    expect(JSON.stringify(json)).not.toContain("07700");
  });

  it("400 / 415: unreadable or non-JSON bodies", async () => {
    expect((await post(null, { raw: "{not json" })).status).toBe(400);
    expect((await post(body, { contentType: "text/plain" })).status).toBe(415);
    expect(engine.createBooking).not.toHaveBeenCalled();
  });

  it("429: when any limit is used up, before the engine runs", async () => {
    for (const scope of ["booking_create_ip", "booking_create_garage", "booking_create_details"]) {
      harness.blockedScopes = new Set([scope]);
      const response = await post(body);
      expect(response.status, scope).toBe(429);
      expect(response.headers.get("retry-after")).toBe("600");
    }
    expect(engine.createBooking).not.toHaveBeenCalled();
  });

  it("403: checks Turnstile when it is configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-test-secret");
    harness.turnstile.mockResolvedValue(false);
    const response = await post({ ...body, turnstileToken: "bad-token" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TURNSTILE_FAILED" });
    expect(harness.turnstile).toHaveBeenCalledWith("bad-token", "198.51.100.7");
    expect(engine.createBooking).not.toHaveBeenCalled();

    harness.turnstile.mockResolvedValue(true);
    expect((await post({ ...body, turnstileToken: "good-token" })).status).toBe(201);
  });

  it("skips Turnstile when it is not configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect((await post(body)).status).toBe(201);
    expect(harness.turnstile).not.toHaveBeenCalled();
  });

  it("404: off a garage host, without rate limiting or booking", async () => {
    harness.garage = null;
    const response = await post({ ...body, garageId: garage.id });
    expect(response.status).toBe(404);
    expect(engine.createBooking).not.toHaveBeenCalled();
    expect(harness.rateLimitCalls).toEqual([]);
  });

  it("books into whichever garage the host is, whatever the body says", async () => {
    harness.garage = other;
    await post(body);
    expect(engine.createBooking.mock.calls[0]?.[0]).toBe(other.id);
  });
});
