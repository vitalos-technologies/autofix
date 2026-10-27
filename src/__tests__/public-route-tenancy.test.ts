import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Garage } from "@/lib/tenancy/garage";
import { otherTestGarage, testGarage } from "./support/garage";

// Public routes take the garage from the request host only (getHostGarage);
// anything garage-like in a body or query string has no effect.

const harness = vi.hoisted(() => ({
  garage: null as Garage | null,
  createBooking: vi.fn(),
  listPublicBookingServices: vi.fn(),
  getAvailableSlotsForService: vi.fn(),
  createEnquiry: vi.fn(),
  getBookingCalendarNotification: vi.fn(),
  rateLimitCalls: [] as Array<[string, string]>,
}));

vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => harness.garage) }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async (identifier: string, scope: string) => {
    harness.rateLimitCalls.push([identifier, scope]);
    return true;
  }),
}));
vi.mock("@/lib/bookings/repository", () => ({
  BookingWorkflowError: class BookingWorkflowError extends Error {
    constructor(message: string, public readonly code: string) { super(message); }
  },
  createBooking: harness.createBooking,
  getBookingCalendarNotification: harness.getBookingCalendarNotification,
}));
vi.mock("@/lib/bookings/services", () => ({
  listPublicBookingServices: harness.listPublicBookingServices,
  getAvailableSlotsForService: harness.getAvailableSlotsForService,
}));
vi.mock("@/lib/enquiries/repository", () => ({ createEnquiry: harness.createEnquiry }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: vi.fn(async () => true) }));

import { POST as createBookingRoute } from "@/app/api/bookings/route";
import { GET as servicesRoute } from "@/app/api/bookings/services/route";
import { POST as slotsRoute } from "@/app/api/bookings/slots/route";
import { GET as calendarRoute } from "@/app/api/bookings/calendar/[reference]/route";
import { POST as enquiryRoute } from "@/app/api/enquiries/route";
import { verifyUploadToken } from "@/lib/enquiries/upload-token";

const garage = testGarage();
const other = otherTestGarage();

function jsonRequest(path: string, body: unknown) {
  return new NextRequest(`https://hartley-road.autofix.vitalos.co.uk${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
    body: JSON.stringify(body),
  });
}

const bookingBody = {
  vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
  serviceKey: "vehicle-diagnostics",
  problemDescription: "Warning light",
  symptoms: [],
  conditionalAnswers: {},
  location: { mode: "workshop" },
  customer: { name: "Test Customer", email: "customer@example.com", phone: "07700 900123" },
  appointmentStart: "2026-11-20T10:00:00.000Z",
  idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
};

describe("public routes resolve the garage from the host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.garage = garage;
    harness.rateLimitCalls = [];
    harness.createBooking.mockResolvedValue({ reference: "HRM-4821", status: "confirmed" });
    harness.listPublicBookingServices.mockResolvedValue([]);
    harness.getAvailableSlotsForService.mockResolvedValue({ slots: [], timeZone: "Europe/London" });
    harness.createEnquiry.mockResolvedValue({ id: "6f1c2a8e-91f4-4d3b-8a3e-1b2c3d4e5f60", persisted: true, notificationStatus: "sent" });
  });

  it("creates a booking for the host's garage and ignores garage_id / garageId in the body", async () => {
    const response = await createBookingRoute(jsonRequest("/api/bookings", { ...bookingBody, garage_id: other.id, garageId: other.id, garage: { id: other.id } }));
    expect(response.status).toBe(201);
    expect(harness.createBooking).toHaveBeenCalledTimes(1);
    const [usedGarage, input] = harness.createBooking.mock.calls[0]!;
    expect(usedGarage).toBe(garage);
    expect(input).not.toHaveProperty("garage_id");
    expect(input).not.toHaveProperty("garageId");
    expect(input).not.toHaveProperty("garage");
    expect(JSON.stringify(harness.createBooking.mock.calls)).not.toContain(other.id);
    // Rate limits are per IP and per garage.
    expect(harness.rateLimitCalls).toContainEqual([garage.id, "booking_create_garage"]);
  });

  it("returns 404 off a garage host without touching the booking engine", async () => {
    harness.garage = null;
    const response = await createBookingRoute(jsonRequest("/api/bookings", { ...bookingBody, garageId: garage.id }));
    expect(response.status).toBe(404);
    expect(harness.createBooking).not.toHaveBeenCalled();
  });

  it("lists services and slots for the host's garage only", async () => {
    await servicesRoute();
    expect(harness.listPublicBookingServices).toHaveBeenCalledWith(garage.id);

    await slotsRoute(jsonRequest("/api/bookings/slots", { serviceKey: "vehicle-diagnostics", locationMode: "workshop", start: "2026-11-20", end: "2026-11-21", garageId: other.id }));
    expect(harness.getAvailableSlotsForService).toHaveBeenCalledWith(expect.objectContaining({ garageId: garage.id, timezone: "Europe/London", serviceKey: "vehicle-diagnostics" }));
    expect(JSON.stringify(harness.getAvailableSlotsForService.mock.calls)).not.toContain(other.id);
  });

  it("stores enquiries for the host's garage and binds the upload token to it", async () => {
    const response = await enquiryRoute(jsonRequest("/api/enquiries", {
      type: "general",
      contact: { name: "Test Customer", email: "customer@example.com", phone: "07700900123", preferredContact: "email" },
      description: "The vehicle has an intermittent warning light.",
      turnstileToken: "token",
      garage_id: other.id,
    }));
    expect(response.status).toBe(201);
    expect(harness.createEnquiry).toHaveBeenCalledWith(garage, expect.not.objectContaining({ garage_id: expect.anything() }));
    const body = await response.json() as { id: string; uploadToken: string };
    expect(verifyUploadToken(body.uploadToken, body.id, garage.id)).toBe(true);
    expect(verifyUploadToken(body.uploadToken, body.id, other.id)).toBe(false);
  });

  it("serves calendar files only for the host's garage and a valid reference", async () => {
    const notFound = await calendarRoute(new NextRequest("https://hartley-road.autofix.vitalos.co.uk/api/bookings/calendar/not-a-ref?signature=x"), { params: Promise.resolve({ reference: "not-a-ref" }) });
    expect(notFound.status).toBe(404);
    harness.garage = null;
    const offHost = await calendarRoute(new NextRequest("https://autofix.vitalos.co.uk/api/bookings/calendar/HRM-4821?signature=x"), { params: Promise.resolve({ reference: "HRM-4821" }) });
    expect(offHost.status).toBe(404);
    expect(harness.getBookingCalendarNotification).not.toHaveBeenCalled();
  });
});
