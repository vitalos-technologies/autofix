import type { VehicleLookupProvider } from "./provider";

export const mockVehicleProvider: VehicleLookupProvider = {
  async lookup(registration) {
    return {
      registration,
      make: "Vauxhall",
      model: "Astra",
      year: 2017,
      fuelType: "Petrol",
      motStatus: "Valid",
      motExpiry: "2027-03-31",
      taxStatus: "Taxed",
      taxDueDate: "2027-01-01",
    };
  },
};
