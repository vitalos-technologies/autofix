/**
 * Bookings for the garage-host browser tests (tests/e2e/manage.spec.ts, booking.spec.ts), made as
 * the service role through `create_booking()` on the seeded `hartley-road` garage, with the manage
 * link token derived exactly as the app derives it (src/lib/booking-engine/manage.ts). Local stack only.
 */
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient, getLocalSupabaseConfig } from "./local-supabase";

/** The local-only manage secret playwright.garage.config.ts gives the server (not a secret). */
export const PLAYWRIGHT_MANAGE_SECRET = process.env.BOOKING_MANAGEMENT_SECRET || "playwright-local-booking-manage-key-not-a-secret";

export type SeededGarage = { id: string; slug: string; name: string; bookingPrefix: string; timezone: string; cutoffHours: number };

export type ManageFixture = {
  id: string;
  reference: string;
  /** Normalised (`MA12BCD`). */
  registration: string;
  token: string;
  startsAt: string;
  endsAt: string;
  status: string;
};

type SlotRow = { starts_at: string; ends_at: string; free_count: number };

let client: SupabaseClient | null = null;

export function serviceClient() {
  client ??= createLocalClient(getLocalSupabaseConfig().secretKey);
  return client;
}

export function manageToken(garageId: string, idempotencyKey: string) {
  return createHmac("sha256", PLAYWRIGHT_MANAGE_SECRET).update(`booking-manage-link:v1:${garageId.toLowerCase()}:${idempotencyKey.toLowerCase()}`).digest("base64url");
}

/** A current-format registration no seed or other spec uses (`MA` + two digits + three letters). */
export function randomRegistration() {
  const letters = "ABCDEFGHJKLMNOPRSTUVWXYZ";
  const pick = () => letters[randomInt(letters.length)]!;
  return `M${pick()}${String(randomInt(10, 100))}${pick()}${pick()}${pick()}`;
}

/** Ofcom drama numbers 07700 900500–900998 (the demo seed uses 900101–900299, the booking specs 900412, 900466 and 900999). */
function randomPhone() {
  return `+447700900${randomInt(500, 999)}`;
}

function londonDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + days * 86_400_000));
}

export async function seededGarage(slug = "hartley-road"): Promise<SeededGarage> {
  const { data, error } = await serviceClient().from("garages").select("id,slug,name,booking_prefix,timezone,cancellation_cutoff_h").eq("slug", slug).single();
  if (error || !data) throw new Error(`Seeded garage ${slug} is missing (run pnpm db:seed): ${error?.message}`);
  return { id: data.id, slug: data.slug, name: data.name, bookingPrefix: data.booking_prefix, timezone: data.timezone, cutoffHours: data.cancellation_cutoff_h ?? 24 };
}

async function serviceId(garageId: string, name: string) {
  const { data, error } = await serviceClient().from("services").select("id").eq("garage_id", garageId).eq("name", name).is("deleted_at", null).single();
  if (error || !data) throw new Error(`No ${name} service: ${error?.message}`);
  return data.id as string;
}

async function freeSlots(garageId: string, service: string, fromDays: number, toDays: number) {
  const { data, error } = await serviceClient().rpc("available_slots", {
    p_garage_id: garageId,
    p_service_id: service,
    p_from: londonDate(fromDays),
    p_to: londonDate(toDays),
    p_location_mode: "workshop",
  });
  if (error) throw new Error(`available_slots failed: ${error.message}`);
  return (data as SlotRow[]).filter((slot) => slot.free_count > 0);
}

export type FixtureOptions = {
  /** `Diagnostics` (confirmed) or a service that needs the garage's OK, such as `Brakes` (requested). */
  service?: string;
  /** Book at least this many hours ahead (beyond the cancellation cutoff by default). */
  minHoursAhead?: number;
  customerName?: string;
};

/** Books a free slot through `create_booking()` and returns it with its manage link token. */
export async function createManageFixture(garage: SeededGarage, options: FixtureOptions = {}): Promise<ManageFixture> {
  const service = await serviceId(garage.id, options.service ?? "Diagnostics");
  const earliest = Date.now() + (options.minHoursAhead ?? garage.cutoffHours + 6) * 3_600_000;
  const slots = (await freeSlots(garage.id, service, 0, 13)).filter((slot) => Date.parse(slot.starts_at) >= earliest);
  if (slots.length === 0) throw new Error("No free slot to book a manage fixture");
  // A random free slot keeps parallel runs and other specs out of each other's way.
  const slot = slots[randomInt(Math.min(slots.length, 40))]!;
  const idempotencyKey = randomUUID();
  const token = manageToken(garage.id, idempotencyKey);
  const registration = randomRegistration();
  const { data, error } = await serviceClient().rpc("create_booking", {
    p_garage_id: garage.id,
    p_booking: {
      service_id: service,
      starts_at: slot.starts_at,
      location_mode: "workshop",
      source: "online",
      idempotency_key: idempotencyKey,
      manage_token_hash: createHash("sha256").update(token).digest("hex"),
      symptoms: [],
      customer: { name: options.customerName ?? "Manage Test Customer", phone: randomPhone(), channel: "sms", reminder_consent: false },
      vehicle: { registration, make: "Vauxhall", model: "Astra" },
    },
  });
  if (error) throw new Error(`create_booking failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string; reference: string; status: string; starts_at: string; ends_at: string };
  return { id: row.booking_id, reference: row.reference, registration, token, startsAt: row.starts_at, endsAt: row.ends_at, status: row.status };
}

/**
 * Books every bay still free at one start (a rival who got there first, times the garage's
 * capacity). Returns the booking ids, so the test can free them again.
 */
export async function fillSlot(garage: SeededGarage, startsAt: string, service = "Diagnostics"): Promise<string[]> {
  const id = await serviceId(garage.id, service);
  const ids: string[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await serviceClient().rpc("create_booking", {
      p_garage_id: garage.id,
      p_booking: {
        service_id: id,
        starts_at: startsAt,
        location_mode: "workshop",
        source: "phone",
        idempotency_key: randomUUID(),
        symptoms: [],
        customer: { name: "Rival Customer", phone: randomPhone(), channel: "sms", reminder_consent: false },
        vehicle: { registration: randomRegistration(), make: "Ford", model: "Focus" },
      },
    });
    if (error) {
      if (error.message.startsWith("SLOT_UNAVAILABLE")) return ids;
      throw new Error(`create_booking failed: ${error.message}`);
    }
    ids.push(((Array.isArray(data) ? data[0] : data) as { booking_id: string }).booking_id);
  }
  return ids;
}

export async function setStatus(fixture: Pick<ManageFixture, "id">, status: string) {
  const { error } = await serviceClient().from("bookings").update({ status }).eq("id", fixture.id);
  if (error) throw new Error(`Could not set status ${status}: ${error.message}`);
}

/**
 * Moves a booking to start a few hours from now, inside the garage's cancellation cutoff (as a
 * booking made yesterday for tomorrow morning would be). Tries later starts if its bay is busy.
 */
export async function moveInsideCutoff(fixture: ManageFixture) {
  const length = Date.parse(fixture.endsAt) - Date.parse(fixture.startsAt);
  const base = Math.ceil((Date.now() + 3 * 3_600_000) / 300_000) * 300_000;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const start = new Date(base + attempt * 17 * 60_000);
    const end = new Date(start.getTime() + length);
    const { error } = await serviceClient()
      .from("bookings")
      .update({ starts_at: start.toISOString(), ends_at: end.toISOString(), during: `[${start.toISOString()},${end.toISOString()})` })
      .eq("id", fixture.id);
    if (!error) return { ...fixture, startsAt: start.toISOString(), endsAt: end.toISOString() };
    if (error.code !== "23P01") throw new Error(`Could not move the booking: ${error.message}`);
  }
  throw new Error("No free time inside the cutoff to move the booking to");
}

/** Frees the fixtures' slots again (cancelled bookings hold no bay). */
export async function cancelFixtures(ids: readonly string[]) {
  if (ids.length === 0) return;
  await serviceClient().from("bookings").update({ status: "cancelled", cancellation_reason: "Playwright fixture" }).in("id", [...ids]).in("status", ["requested", "confirmed", "arrived", "collected"]);
}
