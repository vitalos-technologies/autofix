import { describe, expect, it } from "vitest";
import * as mot from "@/lib/vehicle/mot";
import { formatMotDate, toIsoDate, toStatusLabel, withMotVisibility } from "@/lib/vehicle/mot";
import type { VehicleDetails } from "@/types/domain";

const vehicle: VehicleDetails = {
  registration: "AB12CDE",
  make: "Vauxhall",
  model: "Astra",
  motStatus: "Valid",
  motExpiry: "2027-03-31",
  taxStatus: "Taxed",
  taxDueDate: "2027-01-01",
};

describe("MOT visibility", () => {
  it("has no platform-wide default: visibility is always the garage's switch", () => {
    expect(mot).not.toHaveProperty("DEFAULT_MOT_ENABLED");
  });

  it("removes MOT fields when the garage has MOT switched off", () => {
    const visible = withMotVisibility(vehicle, false);
    expect(visible).not.toHaveProperty("motStatus");
    expect(visible).not.toHaveProperty("motExpiry");
    expect(visible).toMatchObject({ registration: "AB12CDE", make: "Vauxhall", taxStatus: "Taxed" });
    expect(vehicle.motStatus).toBe("Valid");
  });

  it("keeps MOT fields when the garage has MOT switched on", () => {
    expect(withMotVisibility(vehicle, true)).toEqual(vehicle);
  });
});

describe("MOT value normalisation", () => {
  it("normalises provider dates and datetimes to ISO dates", () => {
    expect(toIsoDate("2027-03-31")).toBe("2027-03-31");
    expect(toIsoDate("2027-03-31T00:00:00")).toBe("2027-03-31");
    expect(toIsoDate(" 2028-02-29 ")).toBe("2028-02-29");
  });

  it("rejects malformed and impossible dates", () => {
    for (const value of ["31/03/2027", "2027-13-01", "2027-02-29", "", "soon", 20270331, null, undefined]) {
      expect(toIsoDate(value)).toBeUndefined();
    }
  });

  it("keeps short status labels and drops empty ones", () => {
    expect(toStatusLabel("  Not   valid ")).toBe("Not valid");
    expect(toStatusLabel("")).toBeUndefined();
    expect(toStatusLabel(42)).toBeUndefined();
    expect(toStatusLabel("x".repeat(100))).toHaveLength(60);
  });

  it("formats an MOT date without shifting it across the clock change", () => {
    expect(formatMotDate("2026-03-29")).toBe("29 March 2026");
    expect(formatMotDate("2026-10-25")).toBe("25 October 2026");
  });
});
