import { describe, expect, it } from "vitest";
import { createFakeBookingEngine, FAKE_SERVICE_IDS } from "@/lib/booking-engine/fake";
import type { CreateBookingInput } from "@/lib/booking-engine/types";

const GARAGE = "11111111-1111-4111-8111-111111111111";
const OTHER_GARAGE = "22222222-2222-4222-8222-222222222222";
// Tuesday 27 October 2026, 07:00 GMT.
const now = () => new Date("2026-10-27T07:00:00.000Z");

function input(startsAt: string, overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    serviceId: FAKE_SERVICE_IDS.diagnostics,
    startsAt,
    locationMode: "workshop",
    symptoms: [],
    customer: { name: "Sam Tester", phone: "+447700900412", channel: "sms", reminderConsent: false },
    vehicle: { registration: "AB12CDE", make: "Ford", model: "Focus" },
    idempotencyKey: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    source: "online",
    ...overrides,
  };
}

describe("fake booking engine", () => {
  it("lists the same services every time", async () => {
    const engine = createFakeBookingEngine({ now });
    expect(await engine.listOnlineServices(GARAGE)).toEqual(await createFakeBookingEngine({ now }).listOnlineServices(OTHER_GARAGE));
  });

  it("generates deterministic slots in the garage's time zone, with some taken", async () => {
    const engine = createFakeBookingEngine({ now });
    const query = { garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.diagnostics, from: "2026-10-28", to: "2026-10-28" };
    const slots = await engine.getAvailableSlots(query);
    expect(slots).toEqual(await createFakeBookingEngine({ now }).getAvailableSlots(query));
    expect(slots[0]).toMatchObject({ startsAt: "2026-10-28T08:30:00.000Z", endsAt: "2026-10-28T09:30:00.000Z" });
    expect(slots.some((slot) => slot.freeCount === 0)).toBe(true);
    expect(slots.some((slot) => slot.freeCount > 0)).toBe(true);
  });

  it("follows the clock change: 08:30 is 07:30 UTC in summer time", async () => {
    const engine = createFakeBookingEngine({ now: () => new Date("2026-03-27T07:00:00.000Z") });
    const [first] = await engine.getAvailableSlots({ garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.diagnostics, from: "2026-03-30", to: "2026-03-30" });
    expect(first?.startsAt).toBe("2026-03-30T07:30:00.000Z");
  });

  it("is closed on Sundays and drops starts inside the minimum notice", async () => {
    const engine = createFakeBookingEngine({ now: () => new Date("2026-10-27T09:00:00.000Z") });
    expect(await engine.getAvailableSlots({ garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.diagnostics, from: "2026-11-01", to: "2026-11-01" })).toEqual([]);
    const today = await engine.getAvailableSlots({ garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.diagnostics, from: "2026-10-27", to: "2026-10-27" });
    expect(today.every((slot) => Date.parse(slot.startsAt) >= Date.parse("2026-10-27T11:00:00.000Z"))).toBe(true);
  });

  it("offers no mobile slots for a workshop-only service", async () => {
    const engine = createFakeBookingEngine({ now });
    expect(await engine.getAvailableSlots({ garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.fullService, from: "2026-10-28", to: "2026-10-28", locationMode: "mobile" })).toEqual([]);
  });

  it("books a free slot once, replays the same idempotency key, and blocks the slot for others", async () => {
    const engine = createFakeBookingEngine({ now, referencePrefix: "HRM" });
    const query = { garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.diagnostics, from: "2026-10-28", to: "2026-10-28" };
    const free = (await engine.getAvailableSlots(query)).find((slot) => slot.freeCount > 0)!;

    const first = await engine.createBooking(GARAGE, input(free.startsAt));
    expect(first).toMatchObject({ ok: true, replayed: false, booking: { status: "confirmed", startsAt: free.startsAt, endsAt: free.endsAt } });
    if (!first.ok) throw new Error("expected a booking");
    expect(first.booking.reference).toMatch(/^HRM-\d{4}$/);

    const replay = await engine.createBooking(GARAGE, input(free.startsAt));
    expect(replay).toMatchObject({ ok: true, replayed: true, booking: { reference: first.booking.reference } });
    expect(engine.bookings()).toHaveLength(1);

    const taken = (await engine.getAvailableSlots(query)).find((slot) => slot.startsAt === free.startsAt);
    expect(taken?.freeCount).toBe(0);

    const conflict = await engine.createBooking(GARAGE, input(free.startsAt, { idempotencyKey: "7f9619ff-8b86-4011-b42d-00c04fc964ff" }));
    expect(conflict).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    if (conflict.ok) throw new Error("expected a conflict");
    expect(conflict.alternatives).toHaveLength(3);
    expect(conflict.alternatives!.every((slot) => slot.freeCount > 0 && slot.startsAt !== free.startsAt)).toBe(true);

    // Another garage's diary is separate.
    const elsewhere = await engine.createBooking(OTHER_GARAGE, input(free.startsAt, { idempotencyKey: "8f9619ff-8b86-4011-b42d-00c04fc964ff" }));
    expect(elsewhere.ok).toBe(true);
  });

  it("asks for approval on quoted jobs and rejects bad input or a mode the service does not offer", async () => {
    const engine = createFakeBookingEngine({ now });
    const [free] = (await engine.getAvailableSlots({ garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.brakes, from: "2026-10-28", to: "2026-10-28" })).filter((slot) => slot.freeCount > 0);
    expect(await engine.createBooking(GARAGE, input(free!.startsAt, { serviceId: FAKE_SERVICE_IDS.brakes }))).toMatchObject({ ok: true, booking: { status: "requested" } });
    expect(await engine.createBooking(GARAGE, input(free!.startsAt, { serviceId: FAKE_SERVICE_IDS.fullService, locationMode: "mobile", idempotencyKey: "9f9619ff-8b86-4011-b42d-00c04fc964ff" }))).toMatchObject({ ok: false, code: "SERVICE_UNAVAILABLE" });
    expect(await engine.createBooking(GARAGE, { ...input(free!.startsAt), idempotencyKey: "not-a-uuid" })).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
  });

  it("gives a member the staff rules: today from opening, no approval, hours only with an explicit override (A90)", async () => {
    const engine = createFakeBookingEngine({ now });
    const member = "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b";
    const day = { garageId: GARAGE, serviceId: FAKE_SERVICE_IDS.brakes, from: "2026-10-27", to: "2026-10-27" };
    expect((await engine.getAvailableSlots(day)).some((slot) => slot.startsAt === "2026-10-27T08:30:00.000Z")).toBe(false);
    const staff = await engine.getStaffSlots({ ...day, memberId: member });
    expect(staff[0]?.startsAt).toBe("2026-10-27T08:30:00.000Z");
    expect(await engine.getStaffSlots({ ...day, from: "2026-10-26", to: "2026-10-26", memberId: member })).toEqual([]);

    const free = staff.find((slot) => slot.freeCount > 0)!;
    expect(await engine.createBooking(GARAGE, input(free.startsAt, { serviceId: FAKE_SERVICE_IDS.brakes, source: "phone" }), { staff: { memberId: member } }))
      .toMatchObject({ ok: true, booking: { status: "confirmed" } });

    const sunday = "2026-11-01T10:07:00.000Z";
    const key = (n: number) => `6f9619ff-8b86-4011-b42d-00c04fc96${n}00`;
    expect(await engine.createBooking(GARAGE, input(sunday, { source: "walk_in", idempotencyKey: key(1) }), { staff: { memberId: member } })).toMatchObject({ ok: false });
    expect(await engine.createBooking(GARAGE, input(sunday, { source: "walk_in", idempotencyKey: key(2) }), { staff: { memberId: member, overrideHours: true } }))
      .toMatchObject({ ok: true, booking: { status: "confirmed", startsAt: sunday } });
    expect(await engine.createBooking(GARAGE, input(sunday, { source: "walk_in", idempotencyKey: key(3) }), { staff: { memberId: member, overrideHours: true } }))
      .toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    expect(await engine.createBooking(GARAGE, input("2026-11-02T10:07:00.000Z", { idempotencyKey: key(4) }), { staff: { memberId: member, overrideHours: true } }))
      .toMatchObject({ ok: false, code: "INVALID_BOOKING" });
  });
});
