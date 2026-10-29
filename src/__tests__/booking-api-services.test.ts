import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Garage } from "@/lib/tenancy/garage";
import { fakeEngine } from "./support/booking-routes";
import { otherTestGarage, testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({ garage: null as Garage | null, hostError: false }));
vi.mock("@/lib/tenancy/garage", () => ({
  getHostGarage: vi.fn(async () => {
    if (harness.hostError) throw new Error("lookup failed");
    return harness.garage;
  }),
}));

import { GET } from "@/app/api/services/route";
import { setBookingEngineForTests } from "@/lib/booking-engine";

const garage = testGarage();
const engine = fakeEngine();

describe("GET /api/services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.garage = garage;
    harness.hostError = false;
    setBookingEngineForTests(engine);
  });
  afterAll(() => setBookingEngineForTests(null));

  it("200: lists the host garage's online services", async () => {
    const services = [{ id: "33333333-3333-4333-8333-333333333333", name: "Full service" }];
    engine.listOnlineServices.mockResolvedValue(services);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ services });
    expect(engine.listOnlineServices).toHaveBeenCalledWith(garage.id);
  });

  it("leaves prices out when the garage hides them on its booking page", async () => {
    harness.garage = testGarage({ showPrices: false });
    engine.listOnlineServices.mockResolvedValue([
      { id: "33333333-3333-4333-8333-333333333333", name: "Full service", pricePence: 17900, priceMode: "from", durationMin: 180 },
      { id: "44444444-4444-4444-8444-444444444444", name: "Brakes", pricePence: null, priceMode: "quote", durationMin: 90 },
    ]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      services: [
        { id: "33333333-3333-4333-8333-333333333333", name: "Full service", durationMin: 180 },
        { id: "44444444-4444-4444-8444-444444444444", name: "Brakes", durationMin: 90 },
      ],
      pricesHidden: true,
    });
  });

  it("uses whichever garage the host resolves to, never another", async () => {
    harness.garage = otherTestGarage();
    await GET();
    expect(engine.listOnlineServices).toHaveBeenCalledWith(otherTestGarage().id);
    expect(JSON.stringify(engine.listOnlineServices.mock.calls)).not.toContain(garage.id);
  });

  it("404: off a garage host, without touching the engine", async () => {
    harness.garage = null;
    const response = await GET();
    expect(response.status).toBe(404);
    expect(engine.listOnlineServices).not.toHaveBeenCalled();
  });

  it("503: when the host lookup or the engine fails", async () => {
    harness.hostError = true;
    expect((await GET()).status).toBe(503);
    harness.hostError = false;
    engine.listOnlineServices.mockRejectedValue(new Error("db down"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "UNAVAILABLE" });
  });
});
