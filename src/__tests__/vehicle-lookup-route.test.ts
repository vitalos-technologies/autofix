import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ lookup: vi.fn(), allowed: true }));

vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn(async () => harness.allowed) }));
vi.mock("@/lib/vehicle/configured-provider", () => ({ getConfiguredVehicleProvider: vi.fn(() => ({ lookup: harness.lookup })) }));

import { POST } from "@/app/api/vehicle/lookup/route";

function lookupRequest(registration: string) {
  return new NextRequest("https://hartley-road.autofix.vitalos.co.uk/api/vehicle/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ registration }),
  });
}

describe("vehicle lookup route", () => {
  beforeEach(() => {
    harness.allowed = true;
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

  it("keeps MOT data out of the customer response while MOT is switched off", async () => {
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

  it("still rate-limits before calling the provider", async () => {
    harness.allowed = false;
    const response = await POST(lookupRequest("AB12CDE"));
    expect(response.status).toBe(429);
    expect(harness.lookup).not.toHaveBeenCalled();
  });
});
