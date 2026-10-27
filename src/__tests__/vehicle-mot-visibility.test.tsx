// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VehicleCard } from "@/components/book";
import { draftVehicleFromLookup } from "@/lib/booking-flow/vehicle";
import { withMotVisibility } from "@/lib/vehicle/mot";
import type { VehicleDetails } from "@/types/domain";

// MOT is per garage (CLAUDE.md rule 6): a customer sees MOT facts only when the garage has
// `mot_enabled` on. The SOB vehicle summary and MOT details components were replaced by the
// booking flow's VehicleCard (P2.7/P2.8) and removed with the SOB manage page (P2.9); these tests
// keep the same guarantee on the components and helpers that replaced them.

const vehicle: VehicleDetails = {
  registration: "AB12CDE",
  make: "VAUXHALL",
  model: "ASTRA",
  year: 2017,
  fuelType: "PETROL",
  motStatus: "Valid",
  motExpiry: "2027-03-31",
};

const NOW = new Date("2026-10-27T09:00:00.000Z");

describe("MOT facts on the customer's car", () => {
  it("are dropped from the looked-up car before it reaches the booking draft when MOT is off", () => {
    const off = draftVehicleFromLookup(withMotVisibility(vehicle, false), "AB12CDE", false);
    expect(off).toMatchObject({ registration: "AB12CDE", make: "Vauxhall", model: "Astra" });
    expect(off.motExpiry).toBeUndefined();
    expect(JSON.stringify(off)).not.toContain("2027-03-31");

    const on = draftVehicleFromLookup(withMotVisibility(vehicle, true), "AB12CDE", true);
    expect(on.motExpiry).toBe("2027-03-31");
  });

  it("never reach the vehicle card when MOT is off, even with an expiry to hand", () => {
    const { rerender } = render(<VehicleCard make="Vauxhall" model="Astra" motEnabled={false} motExpiry="2027-03-31" now={NOW} />);
    expect(screen.getByText("Vauxhall Astra")).toBeInTheDocument();
    expect(screen.queryByText(/MOT/)).not.toBeInTheDocument();

    rerender(<VehicleCard make="Vauxhall" model="Astra" motEnabled motExpiry="2027-03-31" now={NOW} />);
    expect(screen.getByText("MOT due 31 Mar 2027")).toBeInTheDocument();
  });

  it("show nothing when MOT is on but the provider returned no MOT date", () => {
    render(<VehicleCard make="Vauxhall" model="Astra" motEnabled now={NOW} />);
    expect(screen.queryByTestId("vehicle-mot")).not.toBeInTheDocument();
  });
});
