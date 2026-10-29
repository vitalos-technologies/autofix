import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Garage } from "@/lib/tenancy/garage";
import { fakeEngine } from "./support/booking-routes";
import { otherTestGarage, testGarage } from "./support/garage";

// Public routes take the garage from the request host only (getHostGarage);
// anything garage-like in a body or query string has no effect.

const harness = vi.hoisted(() => ({
  garage: null as Garage | null,
  createEnquiry: vi.fn(),
  loadBookingNotificationContext: vi.fn(),
  rateLimitCalls: [] as Array<[string, string]>,
}));

vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => harness.garage) }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async (identifier: string, scope: string) => {
    harness.rateLimitCalls.push([identifier, scope]);
    return true;
  }),
}));
vi.mock("@/lib/bookings/notification-context", () => ({
  loadBookingNotificationContext: harness.loadBookingNotificationContext,
}));
vi.mock("@/lib/enquiries/repository", () => ({ createEnquiry: harness.createEnquiry }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: vi.fn(async () => true) }));

import { POST as createBookingRoute } from "@/app/api/bookings/route";
import { GET as servicesRoute } from "@/app/api/services/route";
import { GET as slotsRoute } from "@/app/api/slots/route";
import { setBookingEngineForTests } from "@/lib/booking-engine";
import { GET as calendarRoute } from "@/app/api/bookings/calendar/[reference]/route";
import { POST as enquiryRoute } from "@/app/api/enquiries/route";
import { verifyUploadToken } from "@/lib/enquiries/upload-token";

const garage = testGarage();
const other = otherTestGarage();
const engine = fakeEngine();

function jsonRequest(path: string, body: unknown) {
  return new NextRequest(`https://hartley-road.pitline.co.uk${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
    body: JSON.stringify(body),
  });
}

const SERVICE = "33333333-3333-4333-8333-333333333333";
const bookingBody = {
  serviceId: SERVICE,
  startsAt: "2026-11-20T10:00:00.000Z",
  locationMode: "workshop",
  symptoms: [],
  customer: { name: "Test Customer", email: "customer@example.com", phone: "07700 900123", channel: "sms", reminderConsent: false },
  vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
  idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
};

describe("public routes resolve the garage from the host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.garage = garage;
    harness.rateLimitCalls = [];
    setBookingEngineForTests(engine);
    engine.createBooking.mockResolvedValue({ ok: true, replayed: false, booking: { id: "55555555-5555-4555-8555-555555555555", reference: "HRM-4821", status: "confirmed", startsAt: "2026-11-20T10:00:00.000Z", endsAt: "2026-11-20T11:00:00.000Z", customerId: "c", vehicleId: "v", manageToken: "t" } });
    engine.listOnlineServices.mockResolvedValue([]);
    engine.getAvailableSlots.mockResolvedValue([]);
    harness.createEnquiry.mockResolvedValue({ id: "6f1c2a8e-91f4-4d3b-8a3e-1b2c3d4e5f60", persisted: true, notificationStatus: "sent" });
  });

  it("creates a booking for the host's garage; a garage id in the body is refused, never used", async () => {
    const refused = await createBookingRoute(jsonRequest("/api/bookings", { ...bookingBody, garage_id: other.id, garageId: other.id, garage: { id: other.id } }));
    expect(refused.status).toBe(422);
    expect(engine.createBooking).not.toHaveBeenCalled();

    const response = await createBookingRoute(jsonRequest("/api/bookings", bookingBody));
    expect(response.status).toBe(201);
    expect(engine.createBooking).toHaveBeenCalledTimes(1);
    const [usedGarageId, input] = engine.createBooking.mock.calls[0]!;
    expect(usedGarageId).toBe(garage.id);
    expect(input).not.toHaveProperty("garage_id");
    expect(input).not.toHaveProperty("garageId");
    expect(JSON.stringify(engine.createBooking.mock.calls)).not.toContain(other.id);
    // Rate limits are per IP and per garage.
    expect(harness.rateLimitCalls).toContainEqual([garage.id, "booking_create_garage"]);
  });

  it("returns 404 off a garage host without touching the booking engine", async () => {
    harness.garage = null;
    const response = await createBookingRoute(jsonRequest("/api/bookings", { ...bookingBody, garageId: garage.id }));
    expect(response.status).toBe(404);
    expect(engine.createBooking).not.toHaveBeenCalled();
  });

  it("lists services and slots for the host's garage only", async () => {
    await servicesRoute();
    expect(engine.listOnlineServices).toHaveBeenCalledWith(garage.id);

    const smuggled = await slotsRoute(new NextRequest(`https://hartley-road.pitline.co.uk/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21&garageId=${other.id}`));
    expect(smuggled.status).toBe(422);
    await slotsRoute(new NextRequest(`https://hartley-road.pitline.co.uk/api/slots?service=${SERVICE}&from=2026-11-20&to=2026-11-21&mode=workshop`));
    expect(engine.getAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ garageId: garage.id, serviceId: SERVICE }));
    expect(JSON.stringify(engine.getAvailableSlots.mock.calls)).not.toContain(other.id);
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
    const notFound = await calendarRoute(new NextRequest("https://hartley-road.pitline.co.uk/api/bookings/calendar/not-a-ref?signature=x"), { params: Promise.resolve({ reference: "not-a-ref" }) });
    expect(notFound.status).toBe(404);
    harness.garage = null;
    const offHost = await calendarRoute(new NextRequest("https://pitline.co.uk/api/bookings/calendar/HRM-4821?signature=x"), { params: Promise.resolve({ reference: "HRM-4821" }) });
    expect(offHost.status).toBe(404);
    expect(harness.loadBookingNotificationContext).not.toHaveBeenCalled();
  });
});
