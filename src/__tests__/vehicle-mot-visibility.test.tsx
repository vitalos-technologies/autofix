// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingWizard } from "@/components/booking/booking-wizard";
import { GarageProvider } from "@/components/garage/garage-provider";
import { VehicleSessionProvider } from "@/components/vehicle/vehicle-context";
import { VehicleMotDetails } from "@/components/vehicle/vehicle-mot-details";
import { VehicleSummary } from "@/components/vehicle/vehicle-summary";
import { publicGarage } from "@/lib/tenancy/garage";
import type { VehicleDetails } from "@/types/domain";
import { testGarage } from "./support/garage";

const vehicle: VehicleDetails = {
  registration: "AB12CDE",
  make: "Vauxhall",
  model: "Astra",
  year: 2017,
  fuelType: "Petrol",
  motStatus: "Valid",
  motExpiry: "2027-03-31",
};

function seedConfirmedVehicle() {
  window.sessionStorage.setItem("af-vehicle-session", JSON.stringify({ vehicle, vehicleConfirmed: true }));
}

describe("VehicleMotDetails", () => {
  it("renders nothing when the garage has MOT switched off", () => {
    const { container } = render(<VehicleMotDetails vehicle={vehicle} motEnabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows MOT status and expiry when the garage has MOT switched on", () => {
    render(<VehicleMotDetails vehicle={vehicle} motEnabled />);
    expect(screen.getByText("MOT status")).toBeInTheDocument();
    expect(screen.getByText("Valid")).toBeInTheDocument();
    expect(screen.getByText("MOT expires")).toBeInTheDocument();
    expect(screen.getByText("31 March 2027")).toBeInTheDocument();
  });

  it("renders nothing when MOT is on but the provider returned no MOT data", () => {
    const { container } = render(<VehicleMotDetails vehicle={{}} motEnabled />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("customer vehicle surfaces", () => {
  beforeEach(() => {
    seedConfirmedVehicle();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ services: [] }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("hides MOT facts in the booking wizard when the garage has MOT switched off", async () => {
    render(<GarageProvider garage={publicGarage(testGarage({ motEnabled: false }))}><VehicleSessionProvider><BookingWizard /></VehicleSessionProvider></GarageProvider>);
    expect(await screen.findByText("Vauxhall Astra")).toBeInTheDocument();
    expect(screen.queryByText("MOT expires")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vehicle-mot-details")).not.toBeInTheDocument();
  });

  it("shows MOT facts in the booking wizard when the garage has MOT switched on", async () => {
    render(<GarageProvider garage={publicGarage(testGarage({ motEnabled: true }))}><VehicleSessionProvider><BookingWizard /></VehicleSessionProvider></GarageProvider>);
    expect(await screen.findByText("Vauxhall Astra")).toBeInTheDocument();
    expect(screen.getByText("MOT expires")).toBeInTheDocument();
    expect(screen.getByText("31 March 2027")).toBeInTheDocument();
  });

  it("gates MOT facts in the enquiry vehicle summary the same way", () => {
    const { unmount } = render(<VehicleSessionProvider><VehicleSummary /></VehicleSessionProvider>);
    expect(screen.getByText(/Vauxhall Astra/)).toBeInTheDocument();
    expect(screen.queryByText("MOT status")).not.toBeInTheDocument();
    unmount();

    render(<VehicleSessionProvider><VehicleSummary motEnabled /></VehicleSessionProvider>);
    expect(screen.getByText("MOT status")).toBeInTheDocument();
    expect(screen.getByText("31 March 2027")).toBeInTheDocument();
  });
});
