import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingEngineError } from "@/lib/booking-engine/errors";
import type { Garage } from "@/lib/tenancy/garage";
import { fakeEngine, getRequest } from "./support/booking-routes";
import { otherTestGarage, testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({ garage: null as Garage | null, allow: true, rateLimitCalls: [] as Array<[string, string, number, number]> }));
vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => harness.garage) }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async (identifier: string, scope: string, limit: number, window: number) => {
    harness.rateLimitCalls.push([identifier, scope, limit, window]);
    return harness.allow;
  }),
}));

import { GET } from "@/app/api/slots/route";
import { setBookingEngineForTests } from "@/lib/booking-engine";

const garage = testGarage();
const other = otherTestGarage();
const engine = fakeEngine();
const SERVICE = "33333333-3333-4333-8333-333333333333";
const slots = [{ startsAt: "2026-11-20T10:00:00.000Z", endsAt: "2026-11-20T11:00:00.000Z", freeCount: 2 }];

describe("GET /api/slots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.garage = garage;
    harness.allow = true;
    harness.rateLimitCalls = [];
    engine.getAvailableSlots.mockResolvedValue(slots);
    setBookingEngineForTests(engine);
  });
  afterAll(() => setBookingEngineForTests(null));

  it("200: returns candidate slots for the host garage", async () => {
    const response = await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-26&mode=mobile`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slots, timezone: "Europe/London" });
    expect(engine.getAvailableSlots).toHaveBeenCalledWith({ garageId: garage.id, serviceId: SERVICE, from: "2026-11-20", to: "2026-11-26", locationMode: "mobile" });
    expect(harness.rateLimitCalls).toEqual([[`${garage.id}:198.51.100.7`, "booking_slots", 30, 300]]);
  });

  it("accepts a single day and an omitted mode", async () => {
    expect((await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-20`))).status).toBe(200);
    expect(engine.getAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ locationMode: undefined }));
  });

  it("422: rejects a garage id or a registration in the query instead of ignoring it", async () => {
    for (const extra of [`garage_id=${other.id}`, `garageId=${other.id}`, "registration=AB12CDE", "reg=AB12CDE"]) {
      const response = await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21&${extra}`));
      expect(response.status, extra).toBe(422);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("AB12CDE");
      expect(JSON.stringify(body)).not.toContain(other.id);
    }
    expect(engine.getAvailableSlots).not.toHaveBeenCalled();
  });

  it("422: missing or malformed service, dates and mode, and windows over 14 days", async () => {
    const queries = [
      "from=2026-11-20&to=2026-11-21",
      "service=not-a-uuid&from=2026-11-20&to=2026-11-21",
      `service=${SERVICE}&from=2026-02-30&to=2026-03-01`,
      `service=${SERVICE}&from=20-11-2026&to=2026-11-21`,
      `service=${SERVICE}&from=2026-11-21&to=2026-11-20`,
      `service=${SERVICE}&from=2026-11-20&to=2026-12-04`,
      `service=${SERVICE}&from=2026-11-20&to=2026-11-21&mode=home`,
    ];
    for (const query of queries) {
      expect((await GET(getRequest(`/api/slots?${query}`))).status, query).toBe(422);
    }
    expect((await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-12-03`))).status).toBe(200);
  });

  it("ignores the dev garage switch parameter (the proxy handles it)", async () => {
    expect((await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21&__garage=demo-b`))).status).toBe(200);
    expect(engine.getAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ garageId: garage.id }));
  });

  it("404: off a garage host", async () => {
    harness.garage = null;
    expect((await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21`))).status).toBe(404);
    expect(engine.getAvailableSlots).not.toHaveBeenCalled();
  });

  it("429: when the per-IP, per-garage limit is used up", async () => {
    harness.allow = false;
    const response = await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21`));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(engine.getAvailableSlots).not.toHaveBeenCalled();
  });

  it("422 / 503: maps engine errors", async () => {
    engine.getAvailableSlots.mockRejectedValueOnce(new BookingEngineError("SERVICE_UNAVAILABLE"));
    const unavailableService = await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21`));
    expect(unavailableService.status).toBe(422);
    expect(await unavailableService.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    engine.getAvailableSlots.mockRejectedValueOnce(new Error("socket hang up"));
    const outage = await GET(getRequest(`/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21`));
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ code: "UNAVAILABLE", message: expect.any(String) });
  });
});
