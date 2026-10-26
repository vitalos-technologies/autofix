import { describe, expect, it } from "vitest";
import { normalizeDvlaVehicle } from "@/lib/vehicle/dvla";
import { mockVehicleProvider } from "@/lib/vehicle/mock";
import { normalizeVehicleDataGlobal } from "@/lib/vehicle/vehicle-data-global";

describe("DVLA provider normalization", () => {
  it("keeps identity, MOT and tax fields and discards other upstream data", () => {
    const upstream = {
      registrationNumber: "AB12CDE",
      make: "VAUXHALL",
      yearOfManufacture: 2017,
      colour: "BLUE",
      fuelType: "PETROL",
      engineCapacity: 1398,
      taxStatus: "Taxed",
      taxDueDate: "2027-01-01",
      motStatus: "Valid",
      motExpiryDate: "2027-03-31",
      markedForExport: false,
      dateOfLastV5CIssued: "2024-05-10",
      co2Emissions: 139,
    };
    const result = normalizeDvlaVehicle(upstream, "AB12CDE");
    expect(result).toEqual({
      registration: "AB12CDE",
      make: "Vauxhall",
      year: 2017,
      colour: "Blue",
      fuelType: "Petrol",
      engineCapacityCc: 1398,
      motStatus: "Valid",
      motExpiry: "2027-03-31",
      taxStatus: "Taxed",
      taxDueDate: "2027-01-01",
    });
    expect(result).not.toHaveProperty("markedForExport");
    expect(result).not.toHaveProperty("dateOfLastV5CIssued");
    expect(result).not.toHaveProperty("co2Emissions");
  });

  it("passes non-valid MOT statuses through as given", () => {
    const result = normalizeDvlaVehicle({ make: "FORD", motStatus: " Not valid ", motExpiryDate: "2025-02-28" }, "XY99ZZZ");
    expect(result.motStatus).toBe("Not valid");
    expect(result.motExpiry).toBe("2025-02-28");
  });

  it("drops malformed or impossible MOT and tax dates", () => {
    const result = normalizeDvlaVehicle({ make: "FORD", motExpiryDate: "31/03/2027", taxDueDate: "2027-02-30" }, "XY99ZZZ");
    expect(result.motExpiry).toBeUndefined();
    expect(result.taxDueDate).toBeUndefined();
  });

  it("leaves MOT fields out when DVLA holds no MOT data", () => {
    const result = normalizeDvlaVehicle({ make: "TESLA", yearOfManufacture: 2024 }, "EV24NEW");
    expect(result.motStatus).toBeUndefined();
    expect(result.motExpiry).toBeUndefined();
  });
});

describe("Vehicle Data Global provider normalization", () => {
  const response = {
    ResponseInformation: { StatusCode: 0, StatusMessage: "Success", IsSuccessStatusCode: true },
    Results: {
      VehicleDetails: {
        VehicleIdentification: {
          Vrm: "AB12CDE",
          DvlaMake: "VAUXHALL",
          DvlaModel: "ASTRA",
          YearOfManufacture: 2017,
          DvlaFuelType: "PETROL",
        },
        VehicleHistory: { ColourDetails: { CurrentColour: "BLUE" } },
        DvlaTechnicalDetails: { EngineCapacityCc: 1398 },
        StatusCode: 0,
        StatusMessage: "Success",
      },
      ModelDetails: {
        ModelIdentification: { Make: "VAUXHALL", Model: "ASTRA", ModelVariant: "SRI NAV" },
        BodyDetails: { BodyStyle: "HATCHBACK" },
        Powertrain: { FuelType: "PETROL", Transmission: { TransmissionType: "MANUAL" } },
      },
    },
  };

  it("selects identity fields from the VehicleDetails response", () => {
    const result = normalizeVehicleDataGlobal(response, "AB12CDE");

    expect(result).toEqual({
      registration: "AB12CDE",
      make: "Vauxhall",
      model: "Astra",
      derivative: "Sri Nav",
      year: 2017,
      colour: "Blue",
      fuelType: "Petrol",
      transmission: "Manual",
      engineCapacityCc: 1398,
      bodyType: "Hatchback",
    });
    expect(result).not.toHaveProperty("UkvdId");
    expect(result).not.toHaveProperty("Vin");
  });

  it("passes the MOT due date through when the package includes MOT history", () => {
    const result = normalizeVehicleDataGlobal({
      ...response,
      Results: { ...response.Results, MotHistoryDetails: { MotDueDate: "2027-03-31T00:00:00" } },
    }, "AB12CDE");
    expect(result.motExpiry).toBe("2027-03-31");
  });
});

describe("mock vehicle provider", () => {
  it("returns MOT fields for development and tests", async () => {
    const result = await mockVehicleProvider.lookup("AB12CDE");
    expect(result).toMatchObject({ registration: "AB12CDE", motStatus: "Valid", motExpiry: "2027-03-31" });
  });
});
