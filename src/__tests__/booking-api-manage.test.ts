import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedBooking } from "@/lib/booking-engine/manage";
import type { Garage } from "@/lib/tenancy/garage";
import { getRequest, jsonRequest } from "./support/booking-routes";
import { otherTestGarage, testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({
  garage: null as Garage | null,
  blockedScopes: new Set<string>(),
  rateLimitCalls: [] as Array<[string, string]>,
  findBookingForManage: vi.fn(),
  rescheduleBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));
vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => harness.garage) }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async (identifier: string, scope: string) => {
    harness.rateLimitCalls.push([identifier, scope]);
    return !harness.blockedScopes.has(scope);
  }),
}));
vi.mock("@/lib/booking-engine/manage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-engine/manage")>()),
  findBookingForManage: harness.findBookingForManage,
  rescheduleBooking: harness.rescheduleBooking,
  cancelBooking: harness.cancelBooking,
}));

import { GET, PATCH, POST } from "@/app/api/bookings/manage/route";
import { createManageSession, MANAGE_COOKIE } from "@/lib/booking-engine/manage";

const garage = testGarage();
const other = otherTestGarage();
const BOOKING = "55555555-5555-4555-8555-555555555555";
const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx";

const booking: ManagedBooking = {
  id: BOOKING,
  garageId: garage.id,
  reference: "HRM-4821",
  status: "confirmed",
  startsAt: "2026-11-20T10:00:00.000Z",
  endsAt: "2026-11-20T11:00:00.000Z",
  locationMode: "workshop",
  service: { id: "33333333-3333-4333-8333-333333333333", name: "Full service" },
  vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
  customerFirstName: "Sam",
  canChange: true,
  changeDeadline: "2026-11-19T10:00:00.000Z",
  blockedReason: null,
  serviceId: "33333333-3333-4333-8333-333333333333",
  resourceId: "88888888-8888-4888-8888-888888888881",
  resourceKind: "bay",
  during: null,
  timeZone: "Europe/London",
  idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
  manageTokenHash: "a".repeat(64),
};

const session = (garageId = garage.id, bookingId = BOOKING) => `${MANAGE_COOKIE}=${createManageSession(garageId, bookingId)}`;

function sessionCookie(response: Response) {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(/,(?=\s*\w+=)/).find((part) => part.trim().startsWith(`${MANAGE_COOKIE}=`)) ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.garage = garage;
  harness.blockedScopes = new Set();
  harness.rateLimitCalls = [];
  harness.findBookingForManage.mockResolvedValue(booking);
  harness.rescheduleBooking.mockResolvedValue({ ok: true, booking: { ...booking, startsAt: "2026-11-20T14:00:00.000Z" }, changed: true });
  harness.cancelBooking.mockResolvedValue({ ok: true, booking: { ...booking, status: "cancelled", canChange: false, blockedReason: "status" }, changed: true });
});

describe("GET /api/bookings/manage", () => {
  it("200: a signed link opens the booking and a 30-minute httpOnly session", async () => {
    const response = await GET(getRequest(`/api/bookings/manage?token=${TOKEN}`));
    expect(response.status).toBe(200);
    expect(harness.findBookingForManage).toHaveBeenCalledWith({ garageId: garage.id, token: TOKEN });
    const json = await response.json();
    expect(json.booking).toMatchObject({ reference: "HRM-4821", canChange: true });
    expect(JSON.stringify(json)).not.toContain(BOOKING);
    const cookie = sessionCookie(response);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=1800/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(harness.rateLimitCalls).toEqual([[`${garage.id}:198.51.100.7`, "booking_manage_link"]]);
  });

  it("404: unknown or malformed link tokens look the same", async () => {
    harness.findBookingForManage.mockResolvedValue(null);
    const unknown = await GET(getRequest(`/api/bookings/manage?token=${TOKEN}`));
    const malformed = await GET(getRequest("/api/bookings/manage?token=abc"));
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await unknown.json()).toEqual(await malformed.json());
  });

  it("200 with a session for this garage; 401 without one or with another garage's", async () => {
    const ok = await GET(getRequest("/api/bookings/manage", { cookie: session() }));
    expect(ok.status).toBe(200);
    expect(harness.findBookingForManage).toHaveBeenCalledWith({ garageId: garage.id, bookingId: BOOKING });
    expect((await GET(getRequest("/api/bookings/manage"))).status).toBe(401);
    expect((await GET(getRequest("/api/bookings/manage", { cookie: session(other.id) }))).status).toBe(401);
  });

  it("404 and a cleared cookie when the session's booking is gone", async () => {
    harness.findBookingForManage.mockResolvedValue(null);
    const response = await GET(getRequest("/api/bookings/manage", { cookie: session() }));
    expect(response.status).toBe(404);
    expect(sessionCookie(response)).toMatch(/Max-Age=0/i);
  });

  it("404 off a garage host; 429 when limited; 503 when the lookup fails", async () => {
    harness.garage = null;
    expect((await GET(getRequest(`/api/bookings/manage?token=${TOKEN}`))).status).toBe(404);
    harness.garage = garage;
    harness.blockedScopes = new Set(["booking_manage_link"]);
    expect((await GET(getRequest(`/api/bookings/manage?token=${TOKEN}`))).status).toBe(429);
    harness.blockedScopes = new Set();
    harness.findBookingForManage.mockRejectedValue(new Error("db down"));
    expect((await GET(getRequest(`/api/bookings/manage?token=${TOKEN}`))).status).toBe(503);
  });
});

describe("POST /api/bookings/manage", () => {
  it("200: reference + registration in the body open a session", async () => {
    const response = await POST(jsonRequest("/api/bookings/manage", { reference: "hrm-4821", registration: "ab12 cde" }));
    expect(response.status).toBe(200);
    expect(harness.findBookingForManage).toHaveBeenCalledWith({ garageId: garage.id, reference: "HRM-4821", registration: "AB12CDE" });
    expect(sessionCookie(response)).toMatch(/HttpOnly/i);
    expect(harness.rateLimitCalls).toEqual([
      [`${garage.id}:198.51.100.7`, "booking_lookup_ip"],
      [`${garage.id}:198.51.100.7:HRM-4821:AB12CDE`, "booking_lookup_details"],
    ]);
  });

  it("404: no match, with no hint about which detail was wrong", async () => {
    harness.findBookingForManage.mockResolvedValue(null);
    const response = await POST(jsonRequest("/api/bookings/manage", { reference: "HRM-4821", registration: "ZZ99ZZZ" }));
    expect(response.status).toBe(404);
    expect(sessionCookie(response)).toBe("");
    expect(JSON.stringify(await response.json())).not.toContain("ZZ99ZZZ");
  });

  it("422: invalid details or a garage id in the body", async () => {
    expect((await POST(jsonRequest("/api/bookings/manage", { reference: "nope", registration: "AB12CDE" }))).status).toBe(422);
    expect((await POST(jsonRequest("/api/bookings/manage", { reference: "HRM-4821", registration: "AB12CDE", garageId: other.id }))).status).toBe(422);
    expect(harness.findBookingForManage).not.toHaveBeenCalled();
  });

  it("429: lookups are limited per IP and per details", async () => {
    harness.blockedScopes = new Set(["booking_lookup_details"]);
    expect((await POST(jsonRequest("/api/bookings/manage", { reference: "HRM-4821", registration: "AB12CDE" }))).status).toBe(429);
    harness.blockedScopes = new Set(["booking_lookup_ip"]);
    expect((await POST(jsonRequest("/api/bookings/manage", { reference: "HRM-4821", registration: "AB12CDE" }))).status).toBe(429);
    expect(harness.findBookingForManage).not.toHaveBeenCalled();
  });

  it("404 off a garage host", async () => {
    harness.garage = null;
    expect((await POST(jsonRequest("/api/bookings/manage", { reference: "HRM-4821", registration: "AB12CDE" }))).status).toBe(404);
  });
});

describe("PATCH /api/bookings/manage", () => {
  const patch = (payload: unknown, cookie?: string) => PATCH(jsonRequest("/api/bookings/manage", payload, { method: "PATCH", cookie }));

  it("200: cancels the session's booking as the customer", async () => {
    const response = await patch({ action: "cancel", reason: "Car sold" }, session());
    expect(response.status).toBe(200);
    expect(harness.cancelBooking).toHaveBeenCalledWith({ garageId: garage.id, bookingId: BOOKING, actor: "customer", reason: "Car sold" });
    expect(await response.json()).toMatchObject({ changed: true, booking: { status: "cancelled" } });
    expect(harness.rateLimitCalls).toContainEqual([`198.51.100.7:${BOOKING}`, "booking_cancel"]);
  });

  it("200: reschedules the session's booking", async () => {
    const response = await patch({ action: "reschedule", startsAt: "2026-11-20T14:00:00Z" }, session());
    expect(response.status).toBe(200);
    expect(harness.rescheduleBooking).toHaveBeenCalledWith({ garageId: garage.id, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "customer" });
    expect(harness.rateLimitCalls).toContainEqual([`198.51.100.7:${BOOKING}`, "booking_reschedule"]);
  });

  it("200: a link token in the body works instead of a session", async () => {
    expect((await patch({ action: "cancel", token: TOKEN })).status).toBe(200);
    expect(harness.findBookingForManage).toHaveBeenCalledWith({ garageId: garage.id, token: TOKEN });
    harness.findBookingForManage.mockResolvedValue(null);
    expect((await patch({ action: "cancel", token: TOKEN })).status).toBe(404);
  });

  it("401: without a session, or with a session from another garage", async () => {
    expect((await patch({ action: "cancel" })).status).toBe(401);
    expect((await patch({ action: "cancel" }, session(other.id))).status).toBe(401);
    expect(harness.cancelBooking).not.toHaveBeenCalled();
  });

  it("409: cutoff, finished bookings and lost slots (with alternatives)", async () => {
    harness.cancelBooking.mockResolvedValueOnce({ ok: false, code: "CUTOFF_PASSED", message: "Too close" });
    expect((await patch({ action: "cancel" }, session())).status).toBe(409);
    harness.cancelBooking.mockResolvedValueOnce({ ok: false, code: "NOT_MODIFIABLE", message: "Finished" });
    expect((await patch({ action: "cancel" }, session())).status).toBe(409);
    const alternatives = [{ startsAt: "2026-11-21T09:00:00.000Z", endsAt: "2026-11-21T10:00:00.000Z", freeCount: 1 }];
    harness.rescheduleBooking.mockResolvedValueOnce({ ok: false, code: "SLOT_UNAVAILABLE", message: "Taken", alternatives });
    const conflict = await patch({ action: "reschedule", startsAt: "2026-11-20T14:00:00Z" }, session());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "SLOT_UNAVAILABLE", alternatives });
  });

  it("422: unknown actions, missing times and extra keys", async () => {
    for (const payload of [{ action: "delete" }, { action: "reschedule" }, { action: "cancel", bookingId: BOOKING }, { action: "reschedule", startsAt: "tomorrow" }]) {
      expect((await patch(payload, session())).status, JSON.stringify(payload)).toBe(422);
    }
    expect(harness.cancelBooking).not.toHaveBeenCalled();
    expect(harness.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("429 when changes are limited; 404 off a garage host; 503 on failure", async () => {
    harness.blockedScopes = new Set(["booking_cancel"]);
    expect((await patch({ action: "cancel" }, session())).status).toBe(429);
    harness.blockedScopes = new Set();
    harness.cancelBooking.mockRejectedValueOnce(new Error("db down"));
    expect((await patch({ action: "cancel" }, session())).status).toBe(503);
    harness.garage = null;
    expect((await patch({ action: "cancel" }, session())).status).toBe(404);
  });
});
