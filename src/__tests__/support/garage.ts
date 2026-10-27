import type { Garage } from "@/lib/tenancy/garage";

/** A garage profile for unit tests (sample data, never a real business). */
export function testGarage(overrides: Partial<Garage> = {}): Garage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "hartley-road",
    name: "Hartley Road Motors",
    legalName: "Hartley Road Motors Ltd",
    companyNumber: "01234567",
    phone: "+441302000101",
    whatsapp: "+447700900101",
    email: "bookings@hartleyroad.example",
    address: { line1: "4 Hartley Road", town: "Doncaster", postcode: "DN1 2AB" },
    timezone: "Europe/London",
    logoUrl: null,
    accent: "#0f766e",
    plan: "growth",
    motEnabled: false,
    bookingPrefix: "HRM",
    slotStepMin: 15,
    approveOnline: false,
    serviceArea: [],
    cancellationCutoffH: 24,
    smsSender: "HartleyRd",
    status: "active",
    customDomain: null,
    tagline: "Servicing, MOT and repairs",
    invoicePayment: null,
    ...overrides,
  };
}

/** A second garage, for "never crosses garages" assertions. */
export function otherTestGarage(overrides: Partial<Garage> = {}): Garage {
  return testGarage({
    id: "22222222-2222-4222-8222-222222222222",
    slug: "demo-b",
    name: "Demo Garage B",
    legalName: "Demo Garage B Ltd",
    phone: "+441142000202",
    email: "hello@demo-b.example",
    address: { line1: "1 Other Street", town: "Sheffield", postcode: "S1 1AA" },
    accent: "#6d28d9",
    bookingPrefix: "DGB",
    ...overrides,
  });
}
