import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, filterValue, hasFilter, type FakeQuery, type FakeResult, type FakeRpc } from "./support/fake-supabase";

const notifyBooking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking-engine/notify", () => ({ notifyBooking }));

import { BookingEngineError } from "@/lib/booking-engine/errors";
import { deriveManageToken, hashManageToken } from "@/lib/booking-engine/manage";
import { formatTimeRange, isoInstant, parseTimeRange, shiftTimeRange } from "@/lib/booking-engine/range";
import { createSupabaseBookingEngine, normalisePostcode } from "@/lib/booking-engine/repository";
import { clearSlotCache, nearestFreeSlots } from "@/lib/booking-engine/slots";
import type { CreateBookingInput, Slot } from "@/lib/booking-engine/types";

const GARAGE = "11111111-1111-4111-8111-111111111111";
const OTHER_GARAGE = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const MOT_SERVICE = "44444444-4444-4444-8444-444444444444";
const BOOKING = "55555555-5555-4555-8555-555555555555";
const CUSTOMER = "66666666-6666-4666-8666-666666666666";
const VEHICLE = "77777777-7777-4777-8777-777777777777";
const KEY = "f5898238-32a1-4764-b57b-529fa953c941";
const NOW = new Date("2026-11-18T09:00:00.000Z");

type ServiceRow = Record<string, unknown> & { id: string };

function serviceRow(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: SERVICE,
    name: "Full service",
    description: "Oil, filters and checks",
    duration_min: 60,
    buffer_min: 15,
    price_pence: 14900,
    price_mode: "fixed",
    location_mode: "both",
    is_mot: false,
    needs_approval: false,
    min_notice_h: 2,
    max_days_ahead: 60,
    sort: 1,
    online_enabled: true,
    deleted_at: null,
    ...overrides,
  };
}

type World = {
  garage: Record<string, unknown> | null;
  services: ServiceRow[];
  existing: Record<string, unknown> | null;
  rpc: (call: FakeRpc) => FakeResult;
};

function world(overrides: Partial<World> = {}): World {
  return {
    garage: { id: GARAGE, timezone: "Europe/London", mot_enabled: false, status: "active" },
    services: [serviceRow()],
    existing: null,
    rpc: (call) => (call.fn === "create_booking" ? { data: rpcResult() } : { data: [] }),
    ...overrides,
  };
}

function rpcResult(overrides: Record<string, unknown> = {}) {
  return {
    booking_id: BOOKING,
    reference: "HRM-4821",
    status: "confirmed",
    starts_at: "2026-11-20T10:00:00+00:00",
    ends_at: "2026-11-20T11:00:00+00:00",
    customer_id: CUSTOMER,
    vehicle_id: VEHICLE,
    ...overrides,
  };
}

function answer(state: World, query: FakeQuery): FakeResult {
  if (query.table === "garages") return { data: state.garage };
  if (query.table === "services") {
    if (query.single) return { data: state.services.find((row) => row.id === filterValue(query, "eq", "id")) ?? null };
    return { data: state.services };
  }
  if (query.table === "bookings") return { data: state.existing };
  return { data: null };
}

function engineFor(state: World, now = () => NOW) {
  const fake = createFakeSupabase({ from: (query) => answer(state, query), rpc: (call) => state.rpc(call) });
  return { engine: createSupabaseBookingEngine({ client: () => fake.client, now }), fake };
}

function input(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    serviceId: SERVICE,
    startsAt: "2026-11-20T10:00:00.000Z",
    locationMode: "workshop",
    symptoms: ["Warning light"],
    notes: "Rattle at idle",
    customer: { name: "Sam Patel", phone: "07700 900123", email: "sam@example.com", channel: "sms", reminderConsent: true },
    vehicle: { registration: "AB12CDE", make: "Vauxhall", model: "Astra" },
    idempotencyKey: KEY,
    source: "online",
    ...overrides,
  };
}

function slot(startsAt: string, freeCount = 1, minutes = 60): Slot {
  return { startsAt, endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(), freeCount };
}

function slotRows(slots: Slot[]) {
  return slots.map((item) => ({ starts_at: item.startsAt.replace(".000Z", "+00:00"), ends_at: item.endsAt.replace(".000Z", "+00:00"), free_count: item.freeCount }));
}

beforeEach(() => {
  clearSlotCache();
  notifyBooking.mockReset();
  delete process.env.BOOKING_MANAGEMENT_SECRET;
});

describe("listOnlineServices", () => {
  it("reads online, non-deleted services of that garage only, sorted", async () => {
    const { engine, fake } = engineFor(world());
    const services = await engine.listOnlineServices(GARAGE);
    expect(services).toEqual([expect.objectContaining({ id: SERVICE, name: "Full service", durationMin: 60, bufferMin: 15, pricePence: 14900, priceMode: "fixed", locationMode: "both", isMot: false })]);
    const query = fake.queries.find((item) => item.table === "services")!;
    expect(hasFilter(query, "eq", "garage_id", GARAGE)).toBe(true);
    expect(hasFilter(query, "eq", "online_enabled", true)).toBe(true);
    expect(hasFilter(query, "is", "deleted_at", null)).toBe(true);
    expect(query.filters.filter((filter) => filter.method === "order").map((filter) => filter.args[0])).toEqual(["sort", "name"]);
    expect(JSON.stringify(fake.queries)).not.toContain(OTHER_GARAGE);
  });

  it("hides MOT services unless the garage has MOT switched on", async () => {
    const services = [serviceRow(), serviceRow({ id: MOT_SERVICE, name: "MOT", is_mot: true, sort: 0 })];
    const off = await engineFor(world({ services })).engine.listOnlineServices(GARAGE);
    expect(off.map((service) => service.id)).toEqual([SERVICE]);
    const on = await engineFor(world({ services, garage: { id: GARAGE, timezone: "Europe/London", mot_enabled: true, status: "active" } })).engine.listOnlineServices(GARAGE);
    expect(on.map((service) => service.id)).toEqual([SERVICE, MOT_SERVICE]);
  });

  it("never shows a price for quote-only services", async () => {
    const [service] = await engineFor(world({ services: [serviceRow({ price_mode: "quote", price_pence: 9900 })] })).engine.listOnlineServices(GARAGE);
    expect(service?.pricePence).toBeNull();
  });

  it("throws (the route answers 503) when the database fails", async () => {
    const fake = createFakeSupabase({ from: (query) => (query.table === "services" ? { error: { code: "XX000", message: "boom" } } : { data: { id: GARAGE, mot_enabled: false, status: "active" } }) });
    await expect(createSupabaseBookingEngine({ client: () => fake.client }).listOnlineServices(GARAGE)).rejects.toBeInstanceOf(BookingEngineError);
  });
});

describe("getAvailableSlots", () => {
  const query = { garageId: GARAGE, serviceId: SERVICE, from: "2026-11-20", to: "2026-11-21", locationMode: "workshop" as const };

  it("calls available_slots with every argument and normalises timestamps", async () => {
    const rows = slotRows([slot("2026-11-20T10:00:00.000Z", 2), slot("2026-11-20T09:00:00.000Z", 0)]);
    const { engine, fake } = engineFor(world({ rpc: () => ({ data: rows }) }));
    const slots = await engine.getAvailableSlots(query);
    expect(fake.rpcs).toEqual([{ fn: "available_slots", args: { p_garage_id: GARAGE, p_service_id: SERVICE, p_from: "2026-11-20", p_to: "2026-11-21", p_location_mode: "workshop" } }]);
    expect(slots).toEqual([slot("2026-11-20T09:00:00.000Z", 0), slot("2026-11-20T10:00:00.000Z", 2)]);
  });

  it("passes a null location mode when none is chosen", async () => {
    const { engine, fake } = engineFor(world());
    await engine.getAvailableSlots({ ...query, locationMode: undefined });
    expect(fake.rpcs[0]?.args.p_location_mode).toBeNull();
  });

  it("caches for 30 seconds per argument set and garage", async () => {
    let clock = NOW.getTime();
    const { engine, fake } = engineFor(world(), () => new Date(clock));
    await engine.getAvailableSlots(query);
    await engine.getAvailableSlots(query);
    expect(fake.rpcs).toHaveLength(1);
    await engine.getAvailableSlots({ ...query, to: "2026-11-22" });
    await engine.getAvailableSlots({ ...query, garageId: OTHER_GARAGE });
    expect(fake.rpcs).toHaveLength(3);
    clock += 31_000;
    await engine.getAvailableSlots(query);
    expect(fake.rpcs).toHaveLength(4);
  });

  it("is cleared for the garage when a booking is created", async () => {
    const { engine, fake } = engineFor(world());
    await engine.getAvailableSlots(query);
    expect((await engine.createBooking(GARAGE, input())).ok).toBe(true);
    await engine.getAvailableSlots(query);
    expect(fake.rpcs.filter((call) => call.fn === "available_slots")).toHaveLength(2);
  });

  it("does not cache failures", async () => {
    let fail = true;
    const { engine, fake } = engineFor(world({ rpc: () => (fail ? { error: { code: "XX000", message: "down" } } : { data: [] }) }));
    await expect(engine.getAvailableSlots(query)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    fail = false;
    await expect(engine.getAvailableSlots(query)).resolves.toEqual([]);
    expect(fake.rpcs).toHaveLength(2);
  });

  it("maps a raised SERVICE_UNAVAILABLE and rejects malformed queries before the database", async () => {
    const { engine, fake } = engineFor(world({ rpc: () => ({ error: { code: "P0001", message: "SERVICE_UNAVAILABLE: offline" } }) }));
    await expect(engine.getAvailableSlots(query)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(engine.getAvailableSlots({ ...query, from: "2026-13-01" })).rejects.toMatchObject({ code: "INVALID_BOOKING" });
    await expect(engine.getAvailableSlots({ ...query, serviceId: "not-a-uuid" })).rejects.toMatchObject({ code: "INVALID_BOOKING" });
    await expect(engine.getAvailableSlots({ ...query, from: "2026-11-22", to: "2026-11-20" })).rejects.toMatchObject({ code: "INVALID_BOOKING" });
    expect(fake.rpcs).toHaveLength(1);
  });
});

describe("createBooking", () => {
  it("normalises the phone and registration, hashes the manage token and calls create_booking for the given garage", async () => {
    const { engine, fake } = engineFor(world());
    const result = await engine.createBooking(GARAGE, input({ vehicle: { registration: "ab12 cde", make: "Vauxhall" }, customer: { name: "Sam Patel", phone: "+44 (0)7700 900123", channel: "sms", reminderConsent: false } }));
    expect(result).toEqual({
      ok: true,
      replayed: false,
      booking: {
        id: BOOKING,
        reference: "HRM-4821",
        status: "confirmed",
        startsAt: "2026-11-20T10:00:00.000Z",
        endsAt: "2026-11-20T11:00:00.000Z",
        customerId: CUSTOMER,
        vehicleId: VEHICLE,
        manageToken: deriveManageToken(GARAGE, KEY),
      },
    });
    const call = fake.rpcs.find((item) => item.fn === "create_booking")!;
    expect(call.args.p_garage_id).toBe(GARAGE);
    const booking = call.args.p_booking as Record<string, unknown>;
    expect(booking).toMatchObject({
      service_id: SERVICE,
      starts_at: "2026-11-20T10:00:00.000Z",
      location_mode: "workshop",
      postcode: null,
      address: null,
      source: "online",
      idempotency_key: KEY,
      reminder_send_id: null,
      customer: { name: "Sam Patel", phone: "+447700900123", email: null, channel: "sms", reminder_consent: false, consent_source: null },
      vehicle: { registration: "AB12CDE", make: "Vauxhall", model: null, colour: null, fuel: null, year: null, mot_expiry: null },
    });
    const token = deriveManageToken(GARAGE, KEY);
    expect(booking.manage_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(booking.manage_token_hash).toBe(hashManageToken(token));
    expect(JSON.stringify(call)).not.toContain(token);
    expect(notifyBooking).toHaveBeenCalledWith({ type: "created", garageId: GARAGE, bookingId: BOOKING });
  });

  it("records consent from the booking form only when the box was ticked", async () => {
    const { engine, fake } = engineFor(world());
    await engine.createBooking(GARAGE, input());
    const booking = fake.rpcs.find((item) => item.fn === "create_booking")!.args.p_booking as { customer: Record<string, unknown> };
    expect(booking.customer).toMatchObject({ reminder_consent: true, consent_source: "booking", email: "sam@example.com" });
  });

  it("rejects numbers that are not UK mobiles without touching the database", async () => {
    const { engine, fake } = engineFor(world());
    for (const phone of ["01302 000101", "+1 202 555 0100", "12345"]) {
      const result = await engine.createBooking(GARAGE, input({ customer: { ...input().customer, phone } }));
      expect(result).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    }
    expect(fake.rpcs).toHaveLength(0);
    expect(fake.queries).toHaveLength(0);
  });

  it("rejects a garage id or unknown keys in the input (the garage is the caller's argument)", async () => {
    const { engine, fake } = engineFor(world());
    const result = await engine.createBooking(GARAGE, { ...input(), garageId: OTHER_GARAGE } as unknown as CreateBookingInput);
    expect(result).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    expect(fake.rpcs).toHaveLength(0);
  });

  it("needs an address and a valid postcode for mobile visits, and formats the postcode", async () => {
    const { engine, fake } = engineFor(world());
    expect(await engine.createBooking(GARAGE, input({ locationMode: "mobile" }))).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    expect(await engine.createBooking(GARAGE, input({ locationMode: "mobile", postcode: "NOTAPC", address: "1 Station Road" }))).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    expect(await engine.createBooking(GARAGE, input({ locationMode: "mobile", postcode: "dn12ab", address: "1 Station Road" }))).toMatchObject({ ok: true });
    expect(fake.rpcs[0]?.args.p_booking).toMatchObject({ location_mode: "mobile", postcode: "DN1 2AB", address: "1 Station Road" });
    expect(normalisePostcode("sw1a 1aa")).toBe("SW1A 1AA");
    expect(normalisePostcode("DN6  9HF")).toBe("DN6 9HF");
    expect(normalisePostcode("12345")).toBeNull();
  });

  it("refuses services that are offline, deleted, MOT without MOT switched on, or the wrong location", async () => {
    const cases: Array<[Partial<World>, Partial<CreateBookingInput>]> = [
      [{ services: [serviceRow({ online_enabled: false })] }, {}],
      [{ services: [serviceRow({ deleted_at: "2026-11-01T00:00:00Z" })] }, {}],
      [{ services: [serviceRow({ is_mot: true })] }, {}],
      [{ services: [serviceRow({ location_mode: "workshop" })] }, { locationMode: "mobile", postcode: "DN1 2AB", address: "1 Station Road" }],
      [{ services: [] }, {}],
      [{ garage: { id: GARAGE, timezone: "Europe/London", mot_enabled: true, status: "suspended" } }, {}],
    ];
    for (const [state, overrides] of cases) {
      const { engine, fake } = engineFor(world(state));
      expect(await engine.createBooking(GARAGE, input(overrides))).toMatchObject({ ok: false, code: "SERVICE_UNAVAILABLE" });
      expect(fake.rpcs).toHaveLength(0);
    }
  });

  it("lets staff sources book services that are not offered online", async () => {
    const { engine } = engineFor(world({ services: [serviceRow({ online_enabled: false })] }));
    expect(await engine.createBooking(GARAGE, input({ source: "phone" }))).toMatchObject({ ok: true });
  });

  it("returns the existing booking for a repeated idempotency key without calling create_booking", async () => {
    const existing = { id: BOOKING, reference: "HRM-4821", status: "requested", starts_at: "2026-11-20T10:00:00+00:00", ends_at: "2026-11-20T11:00:00+00:00", customer_id: CUSTOMER, vehicle_id: VEHICLE };
    const { engine, fake } = engineFor(world({ existing }));
    const result = await engine.createBooking(GARAGE, input());
    expect(result).toMatchObject({ ok: true, replayed: true, booking: { id: BOOKING, status: "requested", manageToken: deriveManageToken(GARAGE, KEY) } });
    expect(fake.rpcs).toHaveLength(0);
    const lookup = fake.queries.find((query) => query.table === "bookings")!;
    expect(hasFilter(lookup, "eq", "garage_id", GARAGE)).toBe(true);
    expect(hasFilter(lookup, "eq", "idempotency_key", KEY)).toBe(true);
    expect(notifyBooking).not.toHaveBeenCalled();
  });

  it("treats create_booking's own replay flag and a lost unique race as replays", async () => {
    const flagged = engineFor(world({ rpc: () => ({ data: rpcResult({ replayed: true }) }) }));
    expect(await flagged.engine.createBooking(GARAGE, input())).toMatchObject({ ok: true, replayed: true });

    let lookups = 0;
    const raceState = world({ rpc: () => ({ error: { code: "23505", message: "duplicate key" } }) });
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "bookings") {
          lookups += 1;
          return { data: lookups === 1 ? null : { id: BOOKING, reference: "HRM-4821", status: "confirmed", starts_at: "2026-11-20T10:00:00Z", ends_at: "2026-11-20T11:00:00Z", customer_id: CUSTOMER, vehicle_id: VEHICLE } };
        }
        return answer(raceState, query);
      },
      rpc: raceState.rpc,
    });
    const raced = await createSupabaseBookingEngine({ client: () => fake.client, now: () => NOW }).createBooking(GARAGE, input());
    expect(raced).toMatchObject({ ok: true, replayed: true, booking: { reference: "HRM-4821" } });
    expect(notifyBooking).not.toHaveBeenCalled();
  });

  it("returns the 3 nearest free slots, same day first, when the slot was taken", async () => {
    const available = [
      slot("2026-11-20T09:00:00.000Z"),
      slot("2026-11-20T09:30:00.000Z"),
      slot("2026-11-20T10:00:00.000Z", 0),
      slot("2026-11-20T10:30:00.000Z"),
      slot("2026-11-20T11:00:00.000Z", 0),
      slot("2026-11-20T13:00:00.000Z"),
      slot("2026-11-21T09:00:00.000Z"),
    ];
    const { engine, fake } = engineFor(world({
      rpc: (call) => (call.fn === "create_booking" ? { error: { code: "P0001", message: "SLOT_UNAVAILABLE: no free bay" } } : { data: slotRows(available) }),
    }));
    const result = await engine.createBooking(GARAGE, input());
    expect(result).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    if (result.ok) throw new Error("expected a conflict");
    expect(result.alternatives?.map((item) => item.startsAt)).toEqual(["2026-11-20T09:30:00.000Z", "2026-11-20T10:30:00.000Z", "2026-11-20T09:00:00.000Z"]);
    expect(fake.rpcs.find((call) => call.fn === "available_slots")?.args).toEqual({ p_garage_id: GARAGE, p_service_id: SERVICE, p_from: "2026-11-20", p_to: "2026-12-03", p_location_mode: "workshop" });
    expect(notifyBooking).not.toHaveBeenCalled();
  });

  it("treats an exclusion-constraint violation as a lost slot", async () => {
    const { engine } = engineFor(world({ rpc: (call) => (call.fn === "create_booking" ? { error: { code: "23P01", message: "conflicting key value violates exclusion constraint" } } : { data: [] }) }));
    expect(await engine.createBooking(GARAGE, input())).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE", alternatives: [] });
  });

  it("maps raised codes and hides database detail", async () => {
    const cases: Array<[FakeResult["error"], string]> = [
      [{ code: "P0001", message: "OUTSIDE_SERVICE_AREA: DN22 not covered" }, "OUTSIDE_SERVICE_AREA"],
      [{ code: "P0001", message: "SERVICE_UNAVAILABLE" }, "SERVICE_UNAVAILABLE"],
      [{ code: "P0001", message: "INVALID_BOOKING: starts_at" }, "INVALID_BOOKING"],
      [{ code: "P0001", message: "SOMETHING_ELSE" }, "UNAVAILABLE"],
      [{ code: "08006", message: "connection failure at 10.0.0.3" }, "UNAVAILABLE"],
    ];
    for (const [error, code] of cases) {
      const result = await engineFor(world({ rpc: () => ({ error }) })).engine.createBooking(GARAGE, input());
      expect(result).toMatchObject({ ok: false, code });
      if (result.ok) throw new Error("expected a failure");
      expect(result.message).not.toContain(error?.message ?? "");
      expect(result.message).not.toMatch(/P0001|08006|10\.0\.0\.3/);
    }
  });

  it("is UNAVAILABLE without a database or with a malformed result", async () => {
    expect(await createSupabaseBookingEngine({ client: () => null }).createBooking(GARAGE, input())).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(await engineFor(world({ rpc: () => ({ data: { booking_id: "x" } }) })).engine.createBooking(GARAGE, input())).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });

  it("refuses to sign manage links in production without BOOKING_MANAGEMENT_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { engine, fake } = engineFor(world());
      expect(await engine.createBooking(GARAGE, input())).toMatchObject({ ok: false, code: "UNAVAILABLE" });
      expect(fake.rpcs).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("nearest free slots", () => {
  it("groups by the garage's local day across the October clock change", () => {
    // 25 Oct 2026: BST ends at 02:00 local. 23:30 UTC on the 24th is 00:30 BST on the 25th.
    const slots = [slot("2026-10-24T23:30:00.000Z"), slot("2026-10-25T09:00:00.000Z"), slot("2026-10-24T20:00:00.000Z")];
    const picked = nearestFreeSlots(slots, "2026-10-25T08:00:00.000Z", "Europe/London");
    expect(picked.map((item) => item.startsAt)).toEqual(["2026-10-25T09:00:00.000Z", "2026-10-24T23:30:00.000Z"]);
  });

  it("orders following days chronologically after the same day and skips taken slots", () => {
    const slots = [slot("2026-11-23T09:00:00.000Z"), slot("2026-11-21T16:00:00.000Z"), slot("2026-11-21T09:00:00.000Z"), slot("2026-11-22T09:00:00.000Z", 0)];
    expect(nearestFreeSlots(slots, "2026-11-20T10:00:00.000Z", "Europe/London").map((item) => item.startsAt)).toEqual([
      "2026-11-21T09:00:00.000Z",
      "2026-11-21T16:00:00.000Z",
      "2026-11-23T09:00:00.000Z",
    ]);
  });
});

describe("tstzrange helpers", () => {
  it("parses PostgREST's range text and formats a filter literal", () => {
    const range = parseTimeRange("[\"2026-11-20 09:45:00+00\",\"2026-11-20 11:15:00+00\")");
    expect(range?.start.toISOString()).toBe("2026-11-20T09:45:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-11-20T11:15:00.000Z");
    expect(formatTimeRange(shiftTimeRange(range!, 30 * 60_000))).toBe("[2026-11-20T10:15:00.000Z,2026-11-20T11:45:00.000Z)");
    expect(parseTimeRange("[2026-06-01 08:00:00+01,2026-06-01 09:00:00+01)")?.start.toISOString()).toBe("2026-06-01T07:00:00.000Z");
    expect(parseTimeRange("(,)")).toBeNull();
    expect(parseTimeRange("empty")).toBeNull();
    expect(parseTimeRange(null)).toBeNull();
    expect(isoInstant("2026-11-20T10:00:00+00:00")).toBe("2026-11-20T10:00:00.000Z");
    expect(isoInstant("2026-11-20 10:00:00.123456+05:30")).toBe("2026-11-20T04:30:00.123Z");
  });
});
