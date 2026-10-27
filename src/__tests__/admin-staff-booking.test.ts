import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingEngine, CreateBookingInput, CreateBookingResult } from "@/lib/booking-engine/types";
import { otherTestGarage, testGarage } from "./support/garage";

// Staff phone / walk-in bookings (/app/bookings/new): the server-side path for
// the staff sources. The garage is the member's selected garage, never a form
// field, and the booking goes through the engine like every other booking.

const garage = testGarage();
const other = otherTestGarage();
const SERVICE = "6f1c2b9e-1d3a-4c5b-8e7f-90a1b2c3d4e5";
const KEY = "3b2f8c1e-0a4d-4e6f-9b7a-1c2d3e4f5a6b";
const BOOKING = "0f8fad5b-d9cb-469f-a165-70867728950e";

const harness = vi.hoisted(() => ({
  context: null as null | Record<string, unknown>,
  calls: [] as Array<{ garageId: string; input: CreateBookingInput }>,
  result: null as null | CreateBookingResult,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => harness.revalidated.push(path) }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: vi.fn(async () => harness.context) }));
vi.mock("@/lib/booking-engine", async () => {
  const engine: BookingEngine = {
    listOnlineServices: async () => [],
    getAvailableSlots: async () => [{ startsAt: "2026-11-02T09:00:00.000Z", endsAt: "2026-11-02T10:00:00.000Z", freeCount: 2 }],
    createBooking: async (garageId, input) => {
      harness.calls.push({ garageId, input });
      return harness.result!;
    },
  };
  return { getBookingEngine: () => engine };
});

import { createStaffBookingAction, getStaffSlotsAction } from "@/app/app/(protected)/bookings/new/actions";
import { STAFF_CONSENT_WORDING } from "@/lib/admin/staff-booking";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = {
  source: "phone",
  serviceId: SERVICE,
  startsAt: "2026-11-02T09:00:00.000Z",
  locationMode: "workshop",
  registration: "ma12 bcd",
  make: "Ford",
  model: "Focus",
  customerName: "Priya Phone",
  customerPhone: "07700 900488",
  customerEmail: "",
  idempotencyKey: KEY,
};

const idle = { status: "idle" as const, message: "" };

beforeEach(() => {
  harness.context = { user: { id: "user-1" }, garage, mfaRequired: true, mfaVerified: true, mfaState: "verified", client: {} };
  harness.calls = [];
  harness.revalidated = [];
  harness.result = {
    ok: true,
    replayed: false,
    booking: { id: BOOKING, reference: "HRM-4821", status: "confirmed", startsAt: valid.startsAt, endsAt: "2026-11-02T10:00:00.000Z", customerId: "c", vehicleId: "v", manageToken: "t" },
  };
});

afterEach(() => vi.clearAllMocks());

describe("staff booking", () => {
  it("books for the member's garage with the staff source, ignoring a garage id in the form", async () => {
    await expect(createStaffBookingAction(idle, form({ ...valid, garageId: other.id }))).rejects.toThrow(`REDIRECT:/app/bookings/${BOOKING}?notice=created`);
    expect(harness.calls).toHaveLength(1);
    const [{ garageId, input }] = harness.calls as [{ garageId: string; input: CreateBookingInput }];
    expect(garageId).toBe(garage.id);
    expect(input).toMatchObject({
      serviceId: SERVICE,
      source: "phone",
      idempotencyKey: KEY,
      locationMode: "workshop",
      vehicle: { registration: "MA12BCD", make: "Ford", model: "Focus" },
      customer: { name: "Priya Phone", phone: "07700 900488", channel: "sms", reminderConsent: false },
    });
    expect(input.customer.consentText).toBeUndefined();
    expect(harness.revalidated).toContain("/app");
  });

  it("records the consent wording when staff tick the box, and accepts walk-ins", async () => {
    await expect(createStaffBookingAction(idle, form({ ...valid, source: "walk_in", reminderConsent: "on" }))).rejects.toThrow("REDIRECT:");
    expect(harness.calls[0]?.input).toMatchObject({ source: "walk_in", customer: { reminderConsent: true, consentText: STAFF_CONSENT_WORDING } });
  });

  it("only takes the staff sources", async () => {
    for (const source of ["online", "reminder", "ai_agent", ""]) {
      const state = await createStaffBookingAction(idle, form({ ...valid, source }));
      expect(state.status).toBe("error");
      expect(state.fieldErrors?.source).toBeTruthy();
    }
    expect(harness.calls).toEqual([]);
  });

  it("says which details are missing", async () => {
    const state = await createStaffBookingAction(idle, form({ ...valid, registration: "", customerName: "", startsAt: "" }));
    expect(state).toMatchObject({ status: "error", message: "Check the highlighted details." });
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(["customerName", "registration", "startsAt"]);
    expect(harness.calls).toEqual([]);
  });

  it("offers the nearest free times when the slot has just gone", async () => {
    harness.result = {
      ok: false,
      code: "SLOT_UNAVAILABLE",
      message: "That time has just been taken.",
      alternatives: [{ startsAt: "2026-11-02T10:00:00.000Z", endsAt: "2026-11-02T11:00:00.000Z", freeCount: 1 }],
    };
    const state = await createStaffBookingAction(idle, form(valid));
    expect(state).toMatchObject({ status: "error", message: "That time has just gone. Nearest free: Mon 2 Nov, 10:00.", fieldErrors: { startsAt: "Pick another time" } });
  });

  it("loads free times for the member's garage only, after an MFA-verified session check", async () => {
    await expect(getStaffSlotsAction(SERVICE, "2026-11-02", "workshop")).resolves.toEqual({
      ok: true,
      slots: [{ starts_at: "2026-11-02T09:00:00.000Z", ends_at: "2026-11-02T10:00:00.000Z", free_count: 2 }],
    });
    await expect(getStaffSlotsAction("nope", "2026-11-02", "workshop")).resolves.toMatchObject({ ok: false });
    await expect(getStaffSlotsAction(SERVICE, "2026-13-01", "workshop")).resolves.toMatchObject({ ok: false });
    harness.context = { ...harness.context, mfaVerified: false, mfaState: "trusted" };
    await expect(getStaffSlotsAction(SERVICE, "2026-11-02", "workshop")).rejects.toThrow(/^REDIRECT:\/app\/mfa\?/);
  });
});
