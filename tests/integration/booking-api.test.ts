import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLocalSupabaseConfig, provisionLocalTestUsers, type LocalTestUsers } from "../helpers/local-supabase";

// Booking engine + routes against local Supabase with the P2.1–P2.3 SQL
// (`available_slots`, `create_booking`, `no_overlap`). Run with
//   INTEGRATION_SUPABASE_URL=http://127.0.0.1:54321 INTEGRATION_SUPABASE_PUBLISHABLE_KEY=… \
//   INTEGRATION_SUPABASE_SECRET_KEY=… pnpm vitest run --config vitest.integration.config.ts tests/integration/booking-api.test.ts
// Skipped only when no local database is configured.

const configured = Boolean(process.env.INTEGRATION_SUPABASE_URL);

const host = vi.hoisted(() => ({ garage: null as null | Record<string, unknown> }));
vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => host.garage) }));
// The database limiter is exercised elsewhere; these tests make many bookings from one IP.
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn(async () => true) }));

type Engine = typeof import("../../src/lib/booking-engine/repository");
type Manage = typeof import("../../src/lib/booking-engine/manage");

let users: LocalTestUsers;
let engineModule: Engine;
let manage: Manage;
let service: SupabaseClient;
let serviceA: string;
let motServiceA: string;
let serviceB: string;
let day: string;

/** The next Tuesday at least 3 days ahead, as a London date (opening hours below are Tuesdays). */
function nextTuesday() {
  const date = new Date(Date.now() + 3 * 86_400_000);
  while (new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(date) !== "Tue") date.setUTCDate(date.getUTCDate() + 1);
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(date);
}

/** `HH:MM` London time on `day` as an ISO instant. */
function at(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const guess = new Date(`${day}T${time}:00Z`);
  const local = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(guess);
  const [localHours, localMinutes] = local.split(":").map(Number);
  const offset = ((localHours ?? 0) * 60 + (localMinutes ?? 0)) - ((hours ?? 0) * 60 + (minutes ?? 0));
  return new Date(guess.getTime() - offset * 60_000).toISOString();
}

async function insert(table: string, rows: Record<string, unknown>[]) {
  const { data, error } = await service.from(table).insert(rows).select("id");
  if (error) throw new Error(`Could not seed ${table}: ${error.message}`);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

async function seedGarage(garageId: string) {
  await insert("resources", [1, 2, 3].map((sort) => ({ garage_id: garageId, name: `Bay ${sort}`, kind: "bay", active: true, sort })));
  await insert("opening_hours", [{ garage_id: garageId, weekday: 2, opens: "08:00", closes: "17:00" }]);
  const base = { garage_id: garageId, description: "Integration service", duration_min: 60, buffer_min: 0, price_pence: 9900, price_mode: "fixed", location_mode: "workshop", resource_kind: "bay", online_enabled: true, needs_approval: false, min_notice_h: 2, max_days_ahead: 60, is_mot: false };
  const [online] = await insert("services", [{ ...base, name: "Full service", sort: 1 }]);
  const [mot] = await insert("services", [{ ...base, name: "MOT", is_mot: true, sort: 0 }]);
  return { online: online!, mot: mot! };
}

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: serviceA,
    startsAt: at("10:00"),
    locationMode: "workshop" as const,
    symptoms: [],
    customer: { name: "Integration Customer", phone: "07700 900123", email: "integration@example.test", channel: "sms" as const, reminderConsent: false },
    vehicle: { registration: `it${randomUUID().slice(0, 5)}`.toUpperCase(), make: "Test", model: "Fixture" },
    idempotencyKey: randomUUID(),
    source: "online" as const,
    ...overrides,
  };
}

describe.skipIf(!configured).sequential("booking engine against local Supabase", () => {
  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.BOOKING_MANAGEMENT_SECRET = "integration-booking-management-secret-0123456789";
    users = await provisionLocalTestUsers();
    service = users.service;
    ({ online: serviceA, mot: motServiceA } = await seedGarage(users.garageA.id));
    ({ online: serviceB } = await seedGarage(users.garageB.id));
    day = nextTuesday();
    engineModule = await import("../../src/lib/booking-engine/repository");
    manage = await import("../../src/lib/booking-engine/manage");
  });

  const engine = () => engineModule.createSupabaseBookingEngine({ client: () => service });

  it("lists only the garage's own online services and hides MOT while it is off", async () => {
    const services = await engine().listOnlineServices(users.garageA.id);
    expect(services.map((item) => item.id)).toEqual([serviceA]);
    expect(services.map((item) => item.id)).not.toContain(serviceB);
    expect(services.map((item) => item.id)).not.toContain(motServiceA);
  });

  it("offers every 15-minute start on a Tuesday with 3 free bays", async () => {
    const slots = await engine().getAvailableSlots({ garageId: users.garageA.id, serviceId: serviceA, from: day, to: day });
    expect(slots[0]).toEqual({ startsAt: at("08:00"), endsAt: at("09:00"), freeCount: 3 });
    expect(slots.at(-1)?.startsAt).toBe(at("16:00"));
    expect(slots.map((slot) => slot.startsAt)).toContain(at("10:15"));
  });

  it("creates a booking, stores only the token hash, and replays the idempotency key", async () => {
    const input = bookingInput({ vehicle: { registration: "it 12 abc", make: "Test" } });
    const first = await engine().createBooking(users.garageA.id, input);
    expect(first).toMatchObject({ ok: true, replayed: false, booking: { status: "confirmed", startsAt: at("10:00") } });
    if (!first.ok) throw new Error(first.code);
    expect(first.booking.reference).toMatch(new RegExp(`^${users.garageA.bookingPrefix}-\\d{4,6}$`));

    const { data: row } = await service.from("bookings").select("manage_token_hash,customer_id,vehicle_id,source,status").eq("garage_id", users.garageA.id).eq("id", first.booking.id).single();
    expect(row?.manage_token_hash).toBe(createHash("sha256").update(first.booking.manageToken).digest("hex"));
    expect(row?.source).toBe("online");
    const { data: customer } = await service.from("customers").select("phone").eq("id", first.booking.customerId).single();
    expect(customer?.phone).toBe("+447700900123");
    const { data: vehicle } = await service.from("vehicles").select("registration").eq("id", first.booking.vehicleId).single();
    expect(vehicle?.registration).toBe("IT12ABC");
    const { data: events } = await service.from("booking_events").select("type").eq("garage_id", users.garageA.id).eq("booking_id", first.booking.id);
    expect(events?.map((event) => event.type)).toContain("created");

    const again = await engine().createBooking(users.garageA.id, input);
    expect(again).toMatchObject({ ok: true, replayed: true, booking: { id: first.booking.id, reference: first.booking.reference, manageToken: first.booking.manageToken } });
  });

  it("fills the bays, then answers SLOT_UNAVAILABLE with the nearest free times", async () => {
    for (let bay = 0; bay < 3; bay += 1) {
      expect(await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at("13:00") }))).toMatchObject({ ok: true });
    }
    const slots = await engine().getAvailableSlots({ garageId: users.garageA.id, serviceId: serviceA, from: day, to: day });
    expect(slots.find((slot) => slot.startsAt === at("13:00"))?.freeCount).toBe(0);

    const lost = await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at("13:00") }));
    expect(lost).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    if (lost.ok) throw new Error("expected a conflict");
    expect(lost.alternatives?.length).toBeGreaterThan(0);
    expect(lost.alternatives!.length).toBeLessThanOrEqual(3);
    for (const alternative of lost.alternatives!) {
      expect(alternative.freeCount).toBeGreaterThan(0);
      expect(Math.abs(Date.parse(alternative.startsAt) - Date.parse(at("13:00")))).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });

  it("never books one garage's service into another garage", async () => {
    expect(await engine().createBooking(users.garageB.id, bookingInput({ serviceId: serviceA }))).toMatchObject({ ok: false, code: "SERVICE_UNAVAILABLE" });
    expect(await engine().getAvailableSlots({ garageId: users.garageB.id, serviceId: serviceA, from: day, to: day }).catch(() => [])).toEqual([]);
  });

  it("finds, reschedules and cancels a booking inside its own garage only", async () => {
    const input = bookingInput({ startsAt: at("09:00") });
    const created = await engine().createBooking(users.garageA.id, input);
    if (!created.ok) throw new Error(created.code);

    const byReference = await manage.findBookingForManage({ garageId: users.garageA.id, reference: created.booking.reference, registration: input.vehicle.registration.toLowerCase() });
    expect(byReference?.id).toBe(created.booking.id);
    expect(await manage.findBookingForManage({ garageId: users.garageB.id, reference: created.booking.reference, registration: input.vehicle.registration })).toBeNull();
    expect((await manage.findBookingForManage({ garageId: users.garageA.id, token: created.booking.manageToken }))?.id).toBe(created.booking.id);
    expect(await manage.findBookingForManage({ garageId: users.garageB.id, token: created.booking.manageToken })).toBeNull();

    const moved = await manage.rescheduleBooking({ garageId: users.garageA.id, bookingId: created.booking.id, startsAt: at("15:00"), actor: "customer" });
    expect(moved).toMatchObject({ ok: true, changed: true, booking: { startsAt: at("15:00"), endsAt: at("16:00") } });
    expect(await manage.rescheduleBooking({ garageId: users.garageB.id, bookingId: created.booking.id, startsAt: at("15:30"), actor: "staff" })).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const before = await engine().getAvailableSlots({ garageId: users.garageA.id, serviceId: serviceA, from: day, to: day });
    const cancelled = await manage.cancelBooking({ garageId: users.garageA.id, bookingId: created.booking.id, actor: "customer" });
    expect(cancelled).toMatchObject({ ok: true, booking: { status: "cancelled" } });
    const after = await engine().getAvailableSlots({ garageId: users.garageA.id, serviceId: serviceA, from: day, to: day });
    const freeAt = (slots: typeof after) => slots.find((slot) => slot.startsAt === at("15:00"))?.freeCount ?? 0;
    expect(freeAt(after)).toBe(freeAt(before) + 1);

    const { data: events } = await service.from("booking_events").select("type,actor").eq("garage_id", users.garageA.id).eq("booking_id", created.booking.id);
    expect(events?.map((event) => event.type)).toEqual(expect.arrayContaining(["created", "rescheduled", "cancelled"]));
  });

  it("serves POST /api/bookings for the host's garage: 201, 200 replay, 409 with alternatives", async () => {
    const { POST } = await import("../../src/app/api/bookings/route");
    host.garage = { id: users.garageA.id, slug: users.garageA.slug, name: users.garageA.name, customDomain: null, timezone: "Europe/London" };
    const body = { ...bookingInput({ startsAt: at("11:00") }), source: undefined };
    const request = () => new NextRequest(`http://${users.garageA.slug}.localhost:3000/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.20" },
      body: JSON.stringify({ ...body, garageId: undefined }),
    });
    const created = await POST(request());
    expect(created.status).toBe(201);
    const replay = await POST(request());
    expect(replay.status).toBe(200);
    expect((await replay.json()).booking.reference).toBe((await created.json()).booking.reference);

    for (let bay = 0; bay < 2; bay += 1) await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at("11:00") }));
    const conflict = await POST(new NextRequest(`http://${users.garageA.slug}.localhost:3000/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.21" },
      body: JSON.stringify({ ...bookingInput({ startsAt: at("11:00") }), source: undefined }),
    }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).alternatives.length).toBeGreaterThan(0);
  });
});
