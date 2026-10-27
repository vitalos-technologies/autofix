/**
 * The booking engine through PostgREST (P2.2, P2.3): the calls the
 * repository (src/lib/booking-engine/repository.ts) makes as the service
 * role, with the argument names and result shapes pinned in
 * docs/autofix/ARCHITECTURE.md ("Booking engine"). Slot maths, clock changes
 * and every error code are covered by pgTAP 011 and 012; this suite pins the
 * API surface and runs parallel bookings through the HTTP layer.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createLocalClient,
  createLocalGarage,
  createLocalIdentity,
  getLocalSupabaseConfig,
  localRunId,
  type LocalTestGarage,
} from "../helpers/local-supabase";

type SlotRow = { starts_at: string; ends_at: string; free_count: number };
type BookingResult = {
  booking_id: string;
  reference: string;
  status: string;
  starts_at: string;
  ends_at: string;
  customer_id: string;
  vehicle_id: string;
  replayed: boolean;
};

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);

let garage: LocalTestGarage;
let diagnosticsId: string;
let slots: SlotRow[];

/** A local calendar date in Europe/London, `days` from today. */
function londonDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + days * 86_400_000));
}

function bookingPayload(startsAt: string, number: number, overrides: Record<string, unknown> = {}) {
  const digits = String(number).padStart(3, "0");
  return {
    service_id: diagnosticsId,
    starts_at: startsAt,
    location_mode: "workshop",
    source: "online",
    idempotency_key: randomUUID(),
    symptoms: ["Warning light"],
    customer: { name: `Engine Customer ${digits}`, phone: `+447700900${digits}`, channel: "sms", reminder_consent: false },
    vehicle: { registration: `BE${digits}${localRunId.slice(0, 2)}`.toUpperCase(), make: "Ford", model: "Focus" },
    ...overrides,
  };
}

async function slotsFor(from: string, to: string) {
  const { data, error } = await service.rpc("available_slots", {
    p_garage_id: garage.id,
    p_service_id: diagnosticsId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`available_slots failed: ${error.message}`);
  return data as SlotRow[];
}

beforeAll(async () => {
  garage = await createLocalGarage(service, "be");
  const seeded = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
  if (seeded.error) throw new Error(`seed_garage_defaults failed: ${seeded.error.message}`);
  const found = await service.from("services").select("id").eq("garage_id", garage.id).eq("name", "Diagnostics").single();
  if (found.error || !found.data) throw new Error(`No Diagnostics service: ${found.error?.message}`);
  diagnosticsId = found.data.id;
  slots = await slotsFor(londonDate(1), londonDate(14));
});

describe.sequential("booking engine RPCs (service role)", () => {
  it("seed_garage_defaults adds hours, 3 bays + 1 van and 6 services once", async () => {
    const again = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
    expect(again.error).toBeNull();
    expect(again.data).toEqual({ opening_hours: 0, resources: 0, services: 0 });
    const resources = await service.from("resources").select("kind").eq("garage_id", garage.id);
    expect(resources.data?.map((row) => row.kind).sort()).toEqual(["bay", "bay", "bay", "mobile"]);
  });

  it("available_slots returns (starts_at, ends_at, free_count) rows on the slot step", () => {
    expect(slots.length).toBeGreaterThan(0);
    expect(Object.keys(slots[0]!).sort()).toEqual(["ends_at", "free_count", "starts_at"]);
    for (const slot of slots) {
      expect(slot.free_count).toBe(3);
      expect(new Date(slot.ends_at).getTime() - new Date(slot.starts_at).getTime()).toBe(60 * 60_000);
      expect(new Date(slot.starts_at).getUTCMinutes() % 15).toBe(0);
    }
  });

  it("create_booking returns the contract object and replays by idempotency key", async () => {
    const slot = slots[0]!;
    const payload = bookingPayload(slot.starts_at, 1);
    const first = await service.rpc("create_booking", { p_garage_id: garage.id, p_booking: payload });
    expect(first.error).toBeNull();
    const created = first.data as BookingResult;
    expect(Object.keys(created).sort()).toEqual(["booking_id", "customer_id", "ends_at", "reference", "replayed", "starts_at", "status", "vehicle_id"]);
    expect(created).toMatchObject({ status: "confirmed", replayed: false });
    expect(created.reference).toMatch(new RegExp(`^${garage.bookingPrefix}-\\d{4}$`));
    expect(new Date(created.starts_at).getTime()).toBe(new Date(slot.starts_at).getTime());

    const replay = await service.rpc("create_booking", { p_garage_id: garage.id, p_booking: payload });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...created, replayed: true });

    const after = (await slotsFor(londonDate(1), londonDate(14))).find((row) => row.starts_at === slot.starts_at);
    expect(after?.free_count).toBe(2);
  });

  it("parallel bookings for one start fill the 3 bays and refuse the rest with SLOT_UNAVAILABLE", async () => {
    const firstStart = new Date(slots[0]!.starts_at).getTime();
    const slot = slots.find((row) => new Date(row.starts_at).getTime() >= firstStart + 2 * 3_600_000)!;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => service.rpc("create_booking", { p_garage_id: garage.id, p_booking: bookingPayload(slot.starts_at, 100 + index) })),
    );
    const succeeded = attempts.filter((attempt) => !attempt.error);
    const refused = attempts.filter((attempt) => attempt.error);
    expect(succeeded).toHaveLength(3);
    expect(refused).toHaveLength(5);
    for (const attempt of refused) {
      expect(attempt.error?.code).toBe("P0001");
      expect(attempt.error?.message).toMatch(/^SLOT_UNAVAILABLE/);
    }

    const booked = await service
      .from("bookings")
      .select("resource_id")
      .eq("garage_id", garage.id)
      .eq("starts_at", slot.starts_at)
      .not("status", "in", "(cancelled,no_show)");
    expect(new Set(booked.data?.map((row) => row.resource_id)).size).toBe(3);
    const after = (await slotsFor(londonDate(1), londonDate(14))).find((row) => row.starts_at === slot.starts_at);
    expect(after?.free_count).toBe(0);
  });

  it("raises the documented error codes with errcode P0001", async () => {
    const start = slots.at(-1)!.starts_at;
    const unknownService = await service.rpc("create_booking", {
      p_garage_id: garage.id,
      p_booking: bookingPayload(start, 200, { service_id: randomUUID() }),
    });
    expect(unknownService.error?.code).toBe("P0001");
    expect(unknownService.error?.message).toMatch(/^SERVICE_UNAVAILABLE/);

    const badPhone = await service.rpc("create_booking", {
      p_garage_id: garage.id,
      p_booking: { ...bookingPayload(start, 201), customer: { name: "Local Format", phone: "07700900201" } },
    });
    expect(badPhone.error?.code).toBe("P0001");
    expect(badPhone.error?.message).toMatch(/^INVALID_BOOKING/);

    const badSlots = await service.rpc("available_slots", {
      p_garage_id: garage.id,
      p_service_id: randomUUID(),
      p_from: londonDate(1),
      p_to: londonDate(2),
    });
    expect(badSlots.error?.code).toBe("P0001");
    expect(badSlots.error?.message).toMatch(/^SERVICE_UNAVAILABLE/);
  });

  it("anon and signed-in staff cannot call the engine directly", async () => {
    const member = await createLocalIdentity(service, config.publishableKey, `engine-manager-${localRunId}@example.test`);
    const membership = await service.from("garage_members").insert({ garage_id: garage.id, user_id: member.id, role: "manager" });
    expect(membership.error).toBeNull();
    const clients = [createLocalClient(config.publishableKey), createLocalClient(config.publishableKey, member.accessToken, garage.id)];
    for (const client of clients) {
      const slotCall = await client.rpc("available_slots", { p_garage_id: garage.id, p_service_id: diagnosticsId, p_from: londonDate(1), p_to: londonDate(2) });
      expect(slotCall.error?.code).toBe("42501");
      const bookingCall = await client.rpc("create_booking", { p_garage_id: garage.id, p_booking: bookingPayload(slots.at(-1)!.starts_at, 300) });
      expect(bookingCall.error?.code).toBe("42501");
      const seedCall = await client.rpc("seed_garage_defaults", { p_garage_id: garage.id });
      expect(seedCall.error?.code).toBe("42501");
    }
  });
});
