import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Garage } from "@/lib/tenancy/garage";
import { testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({ lookup: vi.fn(), allowed: true, garage: null as Garage | null }));

vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn(async () => harness.allowed) }));
vi.mock("@/lib/vehicle/configured-provider", () => ({ getConfiguredVehicleProvider: vi.fn(() => ({ lookup: harness.lookup })) }));
vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => harness.garage) }));

import { POST } from "@/app/api/vehicle/lookup/route";

function lookupRequest(registration: string, extra: Record<string, unknown> = {}) {
  return new NextRequest("https://hartley-road.autofix.vitalos.co.uk/api/vehicle/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ registration, ...extra }),
  });
}

describe("vehicle lookup route", () => {
  beforeEach(() => {
    harness.allowed = true;
    harness.garage = testGarage({ motEnabled: false });
    harness.lookup.mockReset();
    harness.lookup.mockResolvedValue({
      registration: "AB12CDE",
      make: "Vauxhall",
      model: "Astra",
      motStatus: "Valid",
      motExpiry: "2027-03-31",
      taxStatus: "Taxed",
    });
  });

  it("keeps MOT data out of the customer response when the host's garage has MOT switched off", async () => {
    const response = await POST(lookupRequest("ab12 cde"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { success: boolean; vehicle: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.vehicle).toMatchObject({ registration: "AB12CDE", make: "Vauxhall", model: "Astra", taxStatus: "Taxed" });
    expect(body.vehicle).not.toHaveProperty("motStatus");
    expect(body.vehicle).not.toHaveProperty("motExpiry");
    expect(harness.lookup).toHaveBeenCalledWith("AB12CDE");
  });

  it("shows MOT data when the host's garage has MOT switched on", async () => {
    harness.garage = testGarage({ motEnabled: true });
    const body = await (await POST(lookupRequest("AB12CDE"))).json() as { vehicle: Record<string, unknown> };
    expect(body.vehicle).toMatchObject({ motStatus: "Valid", motExpiry: "2027-03-31" });
  });

  it("takes MOT visibility from the host, not from anything in the body", async () => {
    harness.garage = testGarage({ motEnabled: false });
    const body = await (await POST(lookupRequest("AB12CDE", { garageId: "22222222-2222-4222-8222-222222222222", motEnabled: true }))).json() as { vehicle: Record<string, unknown> };
    expect(body.vehicle).not.toHaveProperty("motExpiry");
  });

  it("is not found off a garage host", async () => {
    harness.garage = null;
    const response = await POST(lookupRequest("AB12CDE"));
    expect(response.status).toBe(404);
    expect(harness.lookup).not.toHaveBeenCalled();
  });

  it("still rate-limits before calling the provider", async () => {
    harness.allowed = false;
    const response = await POST(lookupRequest("AB12CDE"));
    expect(response.status).toBe(429);
    expect(harness.lookup).not.toHaveBeenCalled();
  });
});
