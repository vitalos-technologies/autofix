import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, filterValue, hasFilter, type FakeQuery, type FakeResult, type FakeRpc } from "./support/fake-supabase";

const harness = vi.hoisted(() => ({ client: null as unknown, notifyBooking: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => harness.client }));
vi.mock("@/lib/booking-engine/notify", () => ({ notifyBooking: harness.notifyBooking }));

import {
  cancelBooking,
  createManageSession,
  deriveManageToken,
  findBookingForManage,
  hashManageToken,
  manageBookingUrl,
  manageTokenForBooking,
  MANAGE_SESSION_SECONDS,
  readManageSession,
  rescheduleBooking,
  toPublicManagedBooking,
} from "@/lib/booking-engine/manage";
import { manageActionSchema, manageLookupSchema } from "@/lib/booking-engine/manage-schema";
import { clearSlotCache } from "@/lib/booking-engine/slots";

const GARAGE = "11111111-1111-4111-8111-111111111111";
const OTHER_GARAGE = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const BOOKING = "55555555-5555-4555-8555-555555555555";
const BAY_1 = "88888888-8888-4888-8888-888888888881";
const BAY_2 = "88888888-8888-4888-8888-888888888882";
const STAFF_USER = "99999999-9999-4999-8999-999999999999";
const KEY = "f5898238-32a1-4764-b57b-529fa953c941";
const NOW = new Date("2026-11-18T09:00:00.000Z");

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING,
    garage_id: GARAGE,
    reference: "HRM-4821",
    status: "confirmed",
    starts_at: "2026-11-20T10:00:00+00:00",
    ends_at: "2026-11-20T11:00:00+00:00",
    during: "[\"2026-11-20 10:00:00+00\",\"2026-11-20 11:15:00+00\")",
    location_mode: "workshop",
    postcode: null,
    resource_id: BAY_1,
    service_id: SERVICE,
    idempotency_key: KEY,
    manage_token_hash: hashManageToken(deriveManageToken(GARAGE, KEY)),
    services: { id: SERVICE, name: "Full service", needs_approval: false },
    resources: { kind: "bay" },
    customers: { name: "Sam Patel" },
    vehicles: { registration: "AB12CDE", make: "Vauxhall", model: "Astra" },
    ...overrides,
  };
}

type World = {
  cutoff: number;
  booking: Record<string, unknown> | null;
  busy: string[];
  resources: string[];
  updateResult: FakeResult;
  slots: Array<{ starts_at: string; ends_at: string; free_count: number }>;
};

function setup(overrides: Partial<World> = {}) {
  const state: World = {
    cutoff: 24,
    booking: bookingRow(),
    busy: [],
    resources: [BAY_1, BAY_2],
    updateResult: { data: { id: BOOKING } },
    slots: [
      { starts_at: "2026-11-20T10:00:00+00:00", ends_at: "2026-11-20T11:00:00+00:00", free_count: 1 },
      { starts_at: "2026-11-20T14:00:00+00:00", ends_at: "2026-11-20T15:00:00+00:00", free_count: 1 },
      { starts_at: "2026-11-21T09:00:00+00:00", ends_at: "2026-11-21T10:00:00+00:00", free_count: 2 },
    ],
    ...overrides,
  };
  const fake = createFakeSupabase({
    from: (query: FakeQuery): FakeResult => {
      if (query.table === "garages") return { data: { id: GARAGE, timezone: "Europe/London", cancellation_cutoff_h: state.cutoff } };
      if (query.table === "resources") return { data: state.resources.map((id, sort) => ({ id, sort })) };
      if (query.table === "booking_events") return { data: null };
      if (query.table === "bookings") {
        if (query.operation === "update") return state.updateResult;
        if (query.columns === "resource_id") return { data: state.busy.map((resource_id) => ({ resource_id })) };
        return { data: state.booking };
      }
      return { data: null };
    },
    rpc: (call: FakeRpc): FakeResult => (call.fn === "available_slots" ? { data: state.slots } : { data: null }),
  });
  harness.client = fake.client;
  return { fake, state };
}

const updates = (queries: FakeQuery[]) => queries.filter((query) => query.table === "bookings" && query.operation === "update");
const events = (queries: FakeQuery[]) => queries.filter((query) => query.table === "booking_events");

beforeEach(() => {
  clearSlotCache();
  harness.notifyBooking.mockReset();
  delete process.env.BOOKING_MANAGEMENT_SECRET;
});

describe("manage link tokens", () => {
  it("are HMAC-derived per garage and idempotency key, and only their SHA-256 is stored", () => {
    process.env.BOOKING_MANAGEMENT_SECRET = "test-secret-with-enough-entropy-for-hmac";
    const token = deriveManageToken(GARAGE, KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveManageToken(GARAGE, KEY)).toBe(token);
    expect(deriveManageToken(OTHER_GARAGE, KEY)).not.toBe(token);
    expect(deriveManageToken(GARAGE, "0e2a6a43-5f2c-4b7e-9c43-0a2c7c1a9d10")).not.toBe(token);
    expect(hashManageToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    process.env.BOOKING_MANAGEMENT_SECRET = "a-different-secret-entirely-for-the-test";
    expect(deriveManageToken(GARAGE, KEY)).not.toBe(token);
  });

  it("are re-issued for later emails only while they still match the stored hash", () => {
    const hash = hashManageToken(deriveManageToken(GARAGE, KEY));
    expect(manageTokenForBooking(GARAGE, { idempotencyKey: KEY, manageTokenHash: hash })).toBe(deriveManageToken(GARAGE, KEY));
    expect(manageTokenForBooking(OTHER_GARAGE, { idempotencyKey: KEY, manageTokenHash: hash })).toBeNull();
    expect(manageTokenForBooking(GARAGE, { idempotencyKey: null, manageTokenHash: hash })).toBeNull();
  });

  it("link to /manage on the garage's own booking host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TENANT_ROOT_DOMAIN", "autofix.vitalos.co.uk");
    try {
      expect(manageBookingUrl({ slug: "hartley-road" }, "abc_DEF-123")).toBe("https://hartley-road.autofix.vitalos.co.uk/manage?token=abc_DEF-123");
      expect(manageBookingUrl({ slug: "hartley-road", customDomain: "book.hartleyroad.co.uk" })).toBe("https://book.hartleyroad.co.uk/manage");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("manage session cookie", () => {
  it("opens one booking on the garage it was issued for, for 30 minutes", () => {
    const now = NOW.getTime();
    const value = createManageSession(GARAGE, BOOKING, now);
    expect(readManageSession(value, GARAGE, now)).toEqual({ bookingId: BOOKING });
    expect(readManageSession(value, OTHER_GARAGE, now)).toBeNull();
    expect(readManageSession(value, GARAGE, now + MANAGE_SESSION_SECONDS * 1000 + 1000)).toBeNull();
    expect(readManageSession(`${value}x`, GARAGE, now)).toBeNull();
    expect(readManageSession(`${value}.extra`, GARAGE, now)).toBeNull();
    const [encoded, signature] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ g: GARAGE, b: "another-booking", e: Math.floor(now / 1000) + 600 })).toString("base64url");
    expect(readManageSession(`${forged}.${signature}`, GARAGE, now)).toBeNull();
    expect(encoded).toBeTruthy();
    expect(readManageSession(undefined, GARAGE, now)).toBeNull();
  });
});

describe("manage schemas", () => {
  it("normalise the reference and registration and reject anything else in the body", () => {
    expect(manageLookupSchema.parse({ reference: " hrm-4821 ", registration: "ab12 cde" })).toEqual({ reference: "HRM-4821", registration: "AB12CDE" });
    expect(manageLookupSchema.safeParse({ reference: "HRM-4821", registration: "AB12CDE", garageId: OTHER_GARAGE }).success).toBe(false);
    for (const reference of ["H-1234", "HRMXX-1234", "HRM-123", "HRM-1234567", "HRM1234"]) {
      expect(manageLookupSchema.safeParse({ reference, registration: "AB12CDE" }).success, reference).toBe(false);
    }
    expect(manageActionSchema.safeParse({ action: "cancel" }).success).toBe(true);
    expect(manageActionSchema.safeParse({ action: "reschedule", startsAt: "2026-11-20T14:00:00Z" }).success).toBe(true);
    expect(manageActionSchema.safeParse({ action: "reschedule" }).success).toBe(false);
    expect(manageActionSchema.safeParse({ action: "delete" }).success).toBe(false);
    expect(manageActionSchema.safeParse({ action: "cancel", bookingId: BOOKING }).success).toBe(false);
  });
});

describe("findBookingForManage", () => {
  it("looks up reference + registration inside the garage only and shows no ids", async () => {
    const { fake } = setup();
    const booking = await findBookingForManage({ garageId: GARAGE, reference: " hrm-4821 ", registration: "ab12 cde" }, NOW);
    const query = fake.queries.find((item) => item.table === "bookings")!;
    expect(query.columns).toContain("vehicles!inner(");
    expect(hasFilter(query, "eq", "garage_id", GARAGE)).toBe(true);
    expect(hasFilter(query, "eq", "reference", "HRM-4821")).toBe(true);
    expect(hasFilter(query, "eq", "vehicles.registration", "AB12CDE")).toBe(true);
    expect(hasFilter(query, "is", "deleted_at", null)).toBe(true);
    expect(booking).toMatchObject({ id: BOOKING, reference: "HRM-4821", canChange: true, blockedReason: null, changeDeadline: "2026-11-19T10:00:00.000Z" });
    const view = toPublicManagedBooking(booking!);
    expect(view).toEqual({
      reference: "HRM-4821",
      status: "confirmed",
      startsAt: "2026-11-20T10:00:00.000Z",
      endsAt: "2026-11-20T11:00:00.000Z",
      locationMode: "workshop",
      service: { id: SERVICE, name: "Full service" },
      vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
      customerFirstName: "Sam",
      canChange: true,
      changeDeadline: "2026-11-19T10:00:00.000Z",
      blockedReason: null,
    });
    expect(JSON.stringify(view)).not.toContain(BOOKING);
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it("finds a signed-link booking by the token's hash, never the token itself", async () => {
    const { fake } = setup();
    const token = deriveManageToken(GARAGE, KEY);
    expect(await findBookingForManage({ garageId: GARAGE, token }, NOW)).toMatchObject({ id: BOOKING });
    const query = fake.queries.find((item) => item.table === "bookings")!;
    expect(filterValue(query, "eq", "manage_token_hash")).toBe(hashManageToken(token));
    expect(JSON.stringify(fake.queries)).not.toContain(token);
  });

  it("returns null for malformed input without querying, and for no match", async () => {
    const { fake } = setup({ booking: null });
    expect(await findBookingForManage({ garageId: GARAGE, token: "short" }, NOW)).toBeNull();
    expect(await findBookingForManage({ garageId: GARAGE, reference: "nope", registration: "AB12CDE" }, NOW)).toBeNull();
    expect(fake.queries.filter((query) => query.table === "bookings")).toHaveLength(0);
    expect(await findBookingForManage({ garageId: GARAGE, reference: "HRM-4821", registration: "AB12CDE" }, NOW)).toBeNull();
  });

  it("closes online changes at the garage's cancellation cutoff and for finished statuses", async () => {
    setup({ cutoff: 72 });
    expect(await findBookingForManage({ garageId: GARAGE, bookingId: BOOKING }, NOW)).toMatchObject({ canChange: false, blockedReason: "cutoff", changeDeadline: "2026-11-17T10:00:00.000Z" });
    setup({ booking: bookingRow({ status: "arrived" }) });
    expect(await findBookingForManage({ garageId: GARAGE, bookingId: BOOKING }, NOW)).toMatchObject({ canChange: false, blockedReason: "status" });
  });
});

describe("rescheduleBooking", () => {
  it("moves the booking to an offered start, shifting the blocked window and keeping a free resource", async () => {
    const { fake } = setup();
    const outcome = await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "customer", now: NOW });
    expect(outcome).toMatchObject({ ok: true, changed: true });

    expect(fake.rpcs[0]).toEqual({ fn: "available_slots", args: { p_garage_id: GARAGE, p_service_id: SERVICE, p_from: "2026-11-20", p_to: "2026-11-20", p_location_mode: "workshop" } });
    const overlap = fake.queries.find((query) => query.table === "bookings" && query.columns === "resource_id")!;
    expect(filterValue(overlap, "overlaps", "during")).toBe("[2026-11-20T14:00:00.000Z,2026-11-20T15:15:00.000Z)");
    expect(hasFilter(overlap, "not", "status")).toBe(true);
    expect(overlap.filters.find((filter) => filter.method === "not")?.args).toEqual(["status", "in", "(cancelled,no_show)"]);
    expect(hasFilter(overlap, "neq", "id", BOOKING)).toBe(true);
    const resources = fake.queries.find((query) => query.table === "resources")!;
    expect(hasFilter(resources, "eq", "kind", "bay")).toBe(true);
    expect(hasFilter(resources, "eq", "active", true)).toBe(true);

    const [update] = updates(fake.queries);
    expect(update?.values).toEqual({
      starts_at: "2026-11-20T14:00:00.000Z",
      ends_at: "2026-11-20T15:00:00.000Z",
      during: "[2026-11-20T14:00:00.000Z,2026-11-20T15:15:00.000Z)",
      resource_id: BAY_1,
    });
    expect(hasFilter(update!, "eq", "garage_id", GARAGE)).toBe(true);
    expect(hasFilter(update!, "in", "status", ["requested", "confirmed"])).toBe(true);
    expect(events(fake.queries)[0]?.values).toEqual({ garage_id: GARAGE, booking_id: BOOKING, type: "rescheduled", actor: "customer", actor_id: null, data: { from: "2026-11-20T10:00:00.000Z", to: "2026-11-20T14:00:00.000Z" } });
    expect(harness.notifyBooking).toHaveBeenCalledWith({ type: "rescheduled", garageId: GARAGE, bookingId: BOOKING, previousStartsAt: "2026-11-20T10:00:00.000Z" });
  });

  it("uses another resource of the same kind when the current one is busy then", async () => {
    const { fake } = setup({ busy: [BAY_1] });
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "customer", now: NOW })).toMatchObject({ ok: true });
    expect(updates(fake.queries)[0]?.values).toMatchObject({ resource_id: BAY_2 });
  });

  it("answers SLOT_UNAVAILABLE with alternatives when every resource is busy or the start is not offered", async () => {
    const busy = setup({ busy: [BAY_1, BAY_2] });
    const full = await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "customer", now: NOW });
    expect(full).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    if (full.ok) throw new Error("expected a conflict");
    expect(full.alternatives?.map((slot) => slot.startsAt)).toEqual(["2026-11-21T09:00:00.000Z"]);
    expect(updates(busy.fake.queries)).toHaveLength(0);

    const offHours = setup();
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T21:00:00Z", actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    expect(updates(offHours.fake.queries)).toHaveLength(0);
    expect(harness.notifyBooking).not.toHaveBeenCalled();
  });

  it("treats the no_overlap constraint as the final word", async () => {
    setup({ updateResult: { error: { code: "23P01", message: "conflicting key value violates exclusion constraint \"no_overlap\"" } } });
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    expect(harness.notifyBooking).not.toHaveBeenCalled();
  });

  it("enforces the cutoff for customers but not for staff", async () => {
    setup({ cutoff: 72 });
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "CUTOFF_PASSED" });
    const { fake } = setup({ cutoff: 72 });
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "staff", actorId: STAFF_USER, now: NOW })).toMatchObject({ ok: true });
    expect(events(fake.queries)[0]?.values).toMatchObject({ actor: "staff", actor_id: STAFF_USER });
  });

  it("refuses cancelled bookings, past times and unknown bookings", async () => {
    setup({ booking: bookingRow({ status: "cancelled" }) });
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "staff", now: NOW })).toMatchObject({ ok: false, code: "NOT_MODIFIABLE" });
    setup();
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-17T14:00:00Z", actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    setup({ booking: null });
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00Z", actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("is a no-op when the start does not change", async () => {
    const { fake } = setup();
    expect(await rescheduleBooking({ garageId: GARAGE, bookingId: BOOKING, startsAt: "2026-11-20T10:00:00.000Z", actor: "customer", now: NOW })).toMatchObject({ ok: true, changed: false });
    expect(updates(fake.queries)).toHaveLength(0);
  });
});

describe("cancelBooking", () => {
  it("cancels within the garage, records the event and frees the slot", async () => {
    const { fake } = setup();
    const outcome = await cancelBooking({ garageId: GARAGE, bookingId: BOOKING, actor: "customer", reason: "Car sold", now: NOW });
    expect(outcome).toMatchObject({ ok: true, changed: true, booking: { status: "cancelled", canChange: false } });
    const [update] = updates(fake.queries);
    expect(update?.values).toEqual({ status: "cancelled", cancelled_at: NOW.toISOString(), cancellation_reason: "Car sold" });
    expect(hasFilter(update!, "eq", "garage_id", GARAGE)).toBe(true);
    expect(hasFilter(update!, "eq", "id", BOOKING)).toBe(true);
    expect(events(fake.queries)[0]?.values).toMatchObject({ garage_id: GARAGE, booking_id: BOOKING, type: "cancelled", actor: "customer", data: { previous_status: "confirmed", reason: "Car sold" } });
    expect(harness.notifyBooking).toHaveBeenCalledWith({ type: "cancelled", garageId: GARAGE, bookingId: BOOKING });
  });

  it("enforces the cutoff for customers only", async () => {
    setup({ cutoff: 72 });
    expect(await cancelBooking({ garageId: GARAGE, bookingId: BOOKING, actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "CUTOFF_PASSED" });
    const { fake } = setup({ cutoff: 72 });
    expect(await cancelBooking({ garageId: GARAGE, bookingId: BOOKING, actor: "staff", actorId: STAFF_USER, now: NOW })).toMatchObject({ ok: true });
    expect(updates(fake.queries)[0]?.values).toMatchObject({ cancellation_reason: "Cancelled by the garage" });
  });

  it("is idempotent for an already cancelled booking and refuses finished ones", async () => {
    const cancelled = setup({ booking: bookingRow({ status: "cancelled" }) });
    expect(await cancelBooking({ garageId: GARAGE, bookingId: BOOKING, actor: "customer", now: NOW })).toMatchObject({ ok: true, changed: false });
    expect(updates(cancelled.fake.queries)).toHaveLength(0);
    setup({ booking: bookingRow({ status: "collected" }) });
    expect(await cancelBooking({ garageId: GARAGE, bookingId: BOOKING, actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "NOT_MODIFIABLE" });
    setup({ updateResult: { data: null } });
    expect(await cancelBooking({ garageId: GARAGE, bookingId: BOOKING, actor: "customer", now: NOW })).toMatchObject({ ok: false, code: "NOT_MODIFIABLE" });
  });
});
