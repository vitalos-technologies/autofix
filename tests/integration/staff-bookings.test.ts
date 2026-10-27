import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalIdentity, getLocalSupabaseConfig, localRunId, provisionLocalTestUsers, type LocalTestUsers } from "../helpers/local-supabase";

// Staff bookings (A90 follow-up, migration 20261028002200, DECISIONS
// A176-A185) through the real engine against local Supabase: a member's phone
// and walk-in bookings may use services not offered online, skip the notice
// period and the booking window, and are confirmed without approval; opening
// hours apply unless the member overrides them; the bay check and other
// garages never bend. Online bookings keep every rule. Skipped only when no
// local database is configured.

const configured = Boolean(process.env.INTEGRATION_SUPABASE_URL);

type Engine = typeof import("../../src/lib/booking-engine/repository");

let users: LocalTestUsers;
let engineModule: Engine;
let service: SupabaseClient;
let onlineService: string;
let offlineService: string;
let approvalService: string;
let near: string;
let far: string;

/** The London date `days` from now, moved on to the next Tuesday (the only opening day below). */
function tuesdayFrom(days: number) {
  const date = new Date(Date.now() + days * 86_400_000);
  while (new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(date) !== "Tue") date.setUTCDate(date.getUTCDate() + 1);
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(date);
}

/** `HH:MM` London time on `day` as an ISO instant. */
function at(day: string, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const guess = new Date(`${day}T${time}:00Z`);
  const local = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(guess);
  const [localHours, localMinutes] = local.split(":").map(Number);
  const offset = ((localHours ?? 0) * 60 + (localMinutes ?? 0)) - ((hours ?? 0) * 60 + (minutes ?? 0));
  return new Date(guess.getTime() - offset * 60_000).toISOString();
}

function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function insert(table: string, rows: Record<string, unknown>[]) {
  const { data, error } = await service.from(table).insert(rows).select("id");
  if (error) throw new Error(`Could not seed ${table}: ${error.message}`);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: offlineService,
    startsAt: at(far, "10:00"),
    locationMode: "workshop" as const,
    symptoms: [],
    customer: { name: "Phone Customer", phone: "07700 900456", channel: "sms" as const, reminderConsent: false },
    vehicle: { registration: `st${randomUUID().slice(0, 5)}`.toUpperCase() },
    idempotencyKey: randomUUID(),
    source: "phone" as const,
    ...overrides,
  };
}

describe.skipIf(!configured).sequential("staff bookings against local Supabase", () => {
  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.BOOKING_MANAGEMENT_SECRET = "integration-booking-management-secret-0123456789";
    users = await provisionLocalTestUsers();
    service = users.service;
    const garageId = users.garageA.id;
    // One bay, Tuesdays 08:00-17:00 only; 24 h notice and a 12-day online window.
    await insert("resources", [{ garage_id: garageId, name: "Bay 1", kind: "bay", active: true, sort: 1 }]);
    await insert("opening_hours", [{ garage_id: garageId, weekday: 2, opens: "08:00", closes: "17:00" }]);
    const base = { garage_id: garageId, description: "Staff booking service", duration_min: 60, buffer_min: 0, price_pence: null, price_mode: "quote", location_mode: "workshop", resource_kind: "bay", needs_approval: false, min_notice_h: 24, max_days_ahead: 12, is_mot: false };
    [onlineService, offlineService, approvalService] = (await insert("services", [
      { ...base, name: "Diagnostics", online_enabled: true, sort: 1 },
      { ...base, name: "Engine rebuild (phone only)", online_enabled: false, sort: 2 },
      { ...base, name: "Brakes", online_enabled: true, needs_approval: true, sort: 3 },
    ])) as [string, string, string];
    near = tuesdayFrom(3);
    far = tuesdayFrom(14);
    engineModule = await import("../../src/lib/booking-engine/repository");
  });

  const engine = () => engineModule.createSupabaseBookingEngine({ client: () => service });
  const staff = (overrideHours = false) => ({ staff: { memberId: users.adminIdentity.id, overrideHours } });

  it("keeps the online rules: no offline services and nothing beyond the window", async () => {
    expect(await engine().createBooking(users.garageA.id, bookingInput({ source: "online" }))).toMatchObject({ ok: false, code: "SERVICE_UNAVAILABLE" });
    expect(await engine().createBooking(users.garageA.id, bookingInput())).toMatchObject({ ok: false, code: "SERVICE_UNAVAILABLE" });
    expect(await engine().getAvailableSlots({ garageId: users.garageA.id, serviceId: onlineService, from: far, to: far })).toEqual([]);
    expect(await engine().createBooking(users.garageA.id, bookingInput({ serviceId: onlineService, source: "online" }))).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
  });

  it("shows a member the staff grid for a service not offered online, beyond the online window", async () => {
    const slots = await engine().getStaffSlots({ garageId: users.garageA.id, serviceId: offlineService, from: far, to: far, memberId: users.adminIdentity.id });
    expect(slots[0]).toEqual({ startsAt: at(far, "08:00"), endsAt: at(far, "09:00"), freeCount: 1 });
    expect(slots.at(-1)?.startsAt).toBe(at(far, "16:00"));
    await expect(engine().getStaffSlots({ garageId: users.garageA.id, serviceId: offlineService, from: far, to: far, memberId: users.otherGarageAdminIdentity.id }))
      .rejects.toMatchObject({ code: "INVALID_BOOKING" });
  });

  it("books a member's phone booking confirmed, and names the member on the timeline", async () => {
    const created = await engine().createBooking(users.garageA.id, bookingInput(), staff());
    expect(created).toMatchObject({ ok: true, replayed: false, booking: { status: "confirmed", startsAt: at(far, "10:00") } });
    if (!created.ok) throw new Error(created.code);
    const { data: row } = await service.from("bookings").select("source,status").eq("garage_id", users.garageA.id).eq("id", created.booking.id).single();
    expect(row).toEqual({ source: "phone", status: "confirmed" });
    const { data: event } = await service.from("booking_events").select("actor,actor_id,data").eq("garage_id", users.garageA.id).eq("booking_id", created.booking.id).eq("type", "created").single();
    expect(event).toMatchObject({ actor: "staff", actor_id: users.adminIdentity.id, data: { staff_rules: true } });

    const grid = await engine().getStaffSlots({ garageId: users.garageA.id, serviceId: offlineService, from: far, to: far, memberId: users.adminIdentity.id });
    expect(grid.find((slot) => slot.startsAt === at(far, "10:00"))?.freeCount).toBe(0);
  });

  it("confirms a member's booking of a service that needs approval, while online it is a request", async () => {
    const byStaff = await engine().createBooking(users.garageA.id, bookingInput({ serviceId: approvalService, startsAt: at(near, "09:00"), source: "walk_in" }), staff());
    expect(byStaff).toMatchObject({ ok: true, booking: { status: "confirmed" } });
    const online = await engine().createBooking(users.garageA.id, bookingInput({ serviceId: approvalService, startsAt: at(near, "13:00"), source: "online" }));
    expect(online).toMatchObject({ ok: true, booking: { status: "requested" } });
  });

  it("keeps opening hours unless the member overrides them, and never double-books the bay", async () => {
    const wednesday = addDays(far, 1);
    expect(await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at(wednesday, "10:00") }), staff())).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    const overridden = await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at(wednesday, "10:07"), source: "walk_in" }), staff(true));
    expect(overridden).toMatchObject({ ok: true, booking: { status: "confirmed", startsAt: at(wednesday, "10:07") } });

    const clash = await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at(wednesday, "10:30") }), staff(true));
    expect(clash).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    const sameSlot = await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at(far, "10:00") }), staff());
    expect(sameSlot).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    if (sameSlot.ok) throw new Error("expected a conflict");
    // Alternatives come from the staff grid (the online window ends before this day).
    expect(sameSlot.alternatives?.length).toBeGreaterThan(0);
  });

  it("lets a front-desk member take a walk-in with the staff rules", async () => {
    const config = getLocalSupabaseConfig();
    const frontDesk = await createLocalIdentity(service, config.publishableKey, `garage-a-front-desk-${localRunId}@example.test`);
    const { error } = await service.from("garage_members").insert({ garage_id: users.garageA.id, user_id: frontDesk.id, role: "front_desk" });
    if (error) throw new Error(`Could not add the front-desk member: ${error.message}`);
    const created = await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at(far, "12:00"), source: "walk_in" }), { staff: { memberId: frontDesk.id } });
    expect(created).toMatchObject({ ok: true, booking: { status: "confirmed" } });
  });

  it("never lets another garage's member, or a non-member, book with staff rules", async () => {
    for (const memberId of [users.otherGarageAdminIdentity.id, users.nonAdminIdentity.id]) {
      const refused = await engine().createBooking(users.garageA.id, bookingInput({ startsAt: at(far, "14:00") }), { staff: { memberId } });
      expect(refused).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    }
    expect(await engine().createBooking(users.garageB.id, bookingInput({ startsAt: at(far, "14:00") }), staff())).toMatchObject({ ok: false });
    const { count } = await service.from("bookings").select("id", { count: "exact", head: true }).eq("garage_id", users.garageB.id);
    expect(count).toBe(0);
  });
});
