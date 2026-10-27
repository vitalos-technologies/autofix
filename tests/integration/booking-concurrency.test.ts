/**
 * Gate 2 (P2.11): parallel bookings never double-book a resource.
 *
 * A fresh garage (service role) with exactly 3 active bays, one inactive bay
 * that must never be used, opening hours 08:00-18:00 every day and one
 * workshop service of 60 minutes plus a 15-minute buffer, so every booking
 * blocks its bay for 75 minutes. 100 `create_booking()` calls go through
 * PostgREST at once, as the booking routes make them (service role), each
 * with its own customer, vehicle and idempotency key:
 *
 *   same start      all 100 ask for 10:00 on one day: exactly 3 win, one per
 *                   bay, and the other 97 get SLOT_UNAVAILABLE.
 *   spread starts   the 100 are spread over every start of another day
 *                   (15-minute step), so the ranges they ask for partially
 *                   overlap each other.
 *
 * Read back as the database owner (psql, not PostgREST): zero overlapping
 * `during` ranges per resource among live bookings (self-join on
 * resource_id with &&), only the active bays used, unique references, and no
 * customer, vehicle or event left behind by a refused call. A refusal must be
 * real: the slot it asked for is full afterwards. Replaying a winner's
 * idempotency key returns the same booking, and copies of one key that race
 * each other book once.
 *
 * The guards are the `no_overlap` exclusion constraint and the per-garage
 * advisory lock in create_booking_at(); with both removed this suite reports
 * the overlapping pairs (P2.11 evidence in docs/autofix/BUILD-PLAN.md).
 */
import { randomUUID } from "node:crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createLocalClient,
  createLocalGarage,
  getLocalSupabaseConfig,
  queryLocalOwnerSql,
  type LocalTestGarage,
} from "../helpers/local-supabase";

const PARALLEL_CALLS = 100;
const ACTIVE_BAYS = 3;
const TIME_ZONE = "Europe/London";
const DURATION_MIN = 60;
const BUFFER_MIN = 15;

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
type Attempt = { payload: BookingPayload; data: BookingResult | null; error: PostgrestError | null };
type BookingPayload = ReturnType<typeof bookingPayload>;
type BookingRow = {
  id: string;
  reference: string;
  resource_id: string;
  starts_at: string;
  during_from: string;
  during_to: string;
  status: string;
  idempotency_key: string;
};
type OverlapRow = { resource_id: string; first_reference: string; second_reference: string; first_during: string; second_during: string };

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);

let garage: LocalTestGarage;
let serviceId: string;
let activeBayIds: string[];
let inactiveBayId: string;

/** A local calendar date in the garage's time zone, `days` from today. */
function localDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(Date.now() + days * 86_400_000));
}

/** "10:00" for an instant, in the garage's time zone. */
function localTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** Call `number` (0-999) gets its own customer (Ofcom drama-range mobile) and vehicle. */
function bookingPayload(startsAt: string, number: number) {
  const digits = String(number).padStart(3, "0");
  return {
    service_id: serviceId,
    starts_at: startsAt,
    location_mode: "workshop",
    source: "online",
    idempotency_key: randomUUID(),
    customer: { name: `Load Customer ${digits}`, phone: `+447700900${digits}`, channel: "sms", reminder_consent: false },
    vehicle: { registration: `LT${digits}`, make: "Ford", model: "Fiesta" },
  };
}

async function createBooking(payload: BookingPayload): Promise<Attempt> {
  const { data, error } = await service.rpc("create_booking", { p_garage_id: garage.id, p_booking: payload });
  return { payload, data: (data as BookingResult | null) ?? null, error };
}

/** Fires every call before awaiting any of them. */
function inParallel(payloads: BookingPayload[]) {
  return Promise.all(payloads.map((payload) => createBooking(payload)));
}

async function slotsOn(day: string): Promise<SlotRow[]> {
  const { data, error } = await service.rpc("available_slots", { p_garage_id: garage.id, p_service_id: serviceId, p_from: day, p_to: day });
  if (error) throw new Error(`available_slots failed: ${error.message}`);
  return data as SlotRow[];
}

function splitAttempts(attempts: Attempt[]) {
  const won = attempts.filter((attempt) => !attempt.error);
  const refused = attempts.filter((attempt) => attempt.error);
  return { won, refused };
}

/** Every refusal is the typed slot error, never a constraint error or a timeout. */
function expectAllSlotUnavailable(refused: Attempt[]) {
  const unexpected = refused
    .filter((attempt) => attempt.error?.code !== "P0001" || !/^SLOT_UNAVAILABLE/.test(attempt.error?.message ?? ""))
    .map((attempt) => ({ code: attempt.error?.code, message: attempt.error?.message }));
  expect(unexpected, "refusals other than SLOT_UNAVAILABLE").toEqual([]);
}

// --- Read-back as the database owner ---------------------------------------

/** Pairs of live bookings on one resource whose `during` ranges overlap. Must always be empty. */
function overlappingPairs(): OverlapRow[] {
  return queryLocalOwnerSql<OverlapRow>(
    `select one_booking.resource_id::text as resource_id,
            one_booking.reference as first_reference, other_booking.reference as second_reference,
            one_booking.during::text as first_during, other_booking.during::text as second_during
       from public.bookings one_booking
       join public.bookings other_booking
         on other_booking.garage_id = one_booking.garage_id
        and other_booking.resource_id = one_booking.resource_id
        and other_booking.id > one_booking.id
        and other_booking.during && one_booking.during
      where one_booking.garage_id = :'garage_id'::uuid
        and one_booking.status not in ('cancelled', 'no_show')
        and other_booking.status not in ('cancelled', 'no_show')
      order by 1, 2, 3`,
    { garage_id: garage.id },
  );
}

function bookingsOn(day: string): BookingRow[] {
  return queryLocalOwnerSql<BookingRow>(
    `select booking.id::text as id, booking.reference, booking.resource_id::text as resource_id,
            booking.starts_at, lower(booking.during) as during_from, upper(booking.during) as during_to,
            booking.status, booking.idempotency_key::text as idempotency_key
       from public.bookings booking
       join public.garages garage on garage.id = booking.garage_id
      where booking.garage_id = :'garage_id'::uuid
        and (booking.starts_at at time zone garage.timezone)::date = :'day'::date
      order by booking.starts_at, booking.reference`,
    { garage_id: garage.id, day },
  );
}

function garageTotals() {
  const [totals] = queryLocalOwnerSql<{ bookings: number; customers: number; vehicles: number; created_events: number; reference_count: number }>(
    `select (select count(*) from public.bookings where garage_id = :'garage_id'::uuid)::int as bookings,
            (select count(distinct reference) from public.bookings where garage_id = :'garage_id'::uuid)::int as reference_count,
            (select count(*) from public.customers where garage_id = :'garage_id'::uuid)::int as customers,
            (select count(*) from public.vehicles where garage_id = :'garage_id'::uuid)::int as vehicles,
            (select count(*) from public.booking_events where garage_id = :'garage_id'::uuid and type = 'created')::int as created_events`,
    { garage_id: garage.id },
  );
  return totals!;
}

// --- Fixture -----------------------------------------------------------------

async function insertRows(table: string, rows: Record<string, unknown>[]) {
  const { data, error } = await service.from(table).insert(rows).select("id");
  if (error || !data) throw new Error(`Could not insert ${table}: ${error?.message}`);
  return (data as { id: string }[]).map((row) => row.id);
}

async function insertRow(table: string, row: Record<string, unknown>) {
  const [id] = await insertRows(table, [row]);
  if (!id) throw new Error(`Could not insert ${table}: no id returned`);
  return id;
}

beforeAll(async () => {
  garage = await createLocalGarage(service, "cc");
  const updated = await service.from("garages").update({ timezone: TIME_ZONE, slot_step_min: 15, approve_online: false }).eq("id", garage.id);
  if (updated.error) throw new Error(`Could not configure the garage: ${updated.error.message}`);

  activeBayIds = await insertRows("resources", Array.from({ length: ACTIVE_BAYS }, (_, index) => ({
    garage_id: garage.id, name: `Bay ${index + 1}`, kind: "bay", active: true, sort: index + 1,
  })));
  inactiveBayId = await insertRow("resources", { garage_id: garage.id, name: "Bay 4 (out of use)", kind: "bay", active: false, sort: 0 });
  await insertRows("opening_hours", [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ garage_id: garage.id, weekday, opens: "08:00", closes: "18:00" })));
  serviceId = await insertRow("services", {
    garage_id: garage.id,
    name: "Load test service",
    duration_min: DURATION_MIN,
    buffer_min: BUFFER_MIN,
    price_pence: 5000,
    price_mode: "fixed",
    location_mode: "workshop",
    resource_kind: "bay",
    online_enabled: true,
    needs_approval: false,
    min_notice_h: 0,
    max_days_ahead: 60,
  });

  // PostgREST opens its pooled connections on demand. Warm the pool first so the
  // first burst reaches the database in parallel instead of one new connection at a time.
  for (let round = 0; round < 3; round += 1) await Promise.all(Array.from({ length: 30 }, () => slotsOn(localDate(2))));
});

// --- Tests -------------------------------------------------------------------

describe.sequential(`${PARALLEL_CALLS} parallel create_booking() calls on ${ACTIVE_BAYS} bays`, () => {
  const sameStartDay = localDate(3);
  const spreadDay = localDate(4);
  const raceDay = localDate(5);
  const winners: Attempt[] = [];

  it("same start: exactly 3 win (one per active bay) and 97 get SLOT_UNAVAILABLE", async () => {
    const slot = (await slotsOn(sameStartDay)).find((row) => localTime(row.starts_at) === "10:00");
    expect(slot, `a 10:00 start on ${sameStartDay}`).toBeDefined();
    expect(slot!.free_count).toBe(ACTIVE_BAYS);

    const attempts = await inParallel(Array.from({ length: PARALLEL_CALLS }, (_, index) => bookingPayload(slot!.starts_at, index)));
    const { won, refused } = splitAttempts(attempts);
    expectAllSlotUnavailable(refused);
    expect(overlappingPairs()).toEqual([]);
    expect(won).toHaveLength(ACTIVE_BAYS);
    expect(refused).toHaveLength(PARALLEL_CALLS - ACTIVE_BAYS);
    for (const attempt of won) {
      expect(attempt.data).toMatchObject({ status: "confirmed", replayed: false });
      expect(Date.parse(attempt.data!.starts_at)).toBe(Date.parse(slot!.starts_at));
    }
    winners.push(...won);

    const booked = bookingsOn(sameStartDay);
    expect(booked).toHaveLength(ACTIVE_BAYS);
    expect(booked.map((row) => row.resource_id).sort()).toEqual([...activeBayIds].sort());
    expect(booked.map((row) => row.id).sort()).toEqual(won.map((attempt) => attempt.data!.booking_id).sort());
    expect((await slotsOn(sameStartDay)).find((row) => row.starts_at === slot!.starts_at)?.free_count).toBe(0);
  });

  it("spread starts: partially overlapping ranges never overlap on one resource, and every refusal is real", async () => {
    const starts = (await slotsOn(spreadDay)).map((row) => row.starts_at);
    // 08:00 to 17:00 every 15 minutes: neighbours 15-60 minutes apart all overlap a 75-minute block.
    expect(starts.length).toBe(37);
    const payloads = Array.from({ length: PARALLEL_CALLS }, (_, index) => bookingPayload(starts[index % starts.length]!, 100 + index));

    const attempts = await inParallel(payloads);
    const { won, refused } = splitAttempts(attempts);
    expectAllSlotUnavailable(refused);
    expect(won.length).toBeGreaterThanOrEqual(ACTIVE_BAYS);
    expect(refused.length).toBeGreaterThan(0);
    winners.push(...won);

    expect(overlappingPairs()).toEqual([]);
    const booked = bookingsOn(spreadDay);
    expect(booked.map((row) => row.id).sort()).toEqual(won.map((attempt) => attempt.data!.booking_id).sort());
    expect(new Set(booked.map((row) => row.resource_id))).toEqual(new Set(activeBayIds));
    expect(booked.some((row) => row.resource_id === inactiveBayId)).toBe(false);
    for (const row of booked) {
      expect(Date.parse(row.during_from)).toBe(Date.parse(row.starts_at));
      expect(Date.parse(row.during_to) - Date.parse(row.starts_at)).toBe((DURATION_MIN + BUFFER_MIN) * 60_000);
    }

    // Bookings are only ever added, so a start refused for want of a bay is still full now.
    const after = new Map((await slotsOn(spreadDay)).map((row) => [Date.parse(row.starts_at), row.free_count]));
    const wronglyRefused = [...new Set(refused.map((attempt) => attempt.payload.starts_at))]
      .filter((start) => after.get(Date.parse(start)) !== 0)
      .map((start) => ({ start: localTime(start), freeNow: after.get(Date.parse(start)) }));
    expect(wronglyRefused, "starts refused while a bay was free").toEqual([]);
  });

  it("refused calls leave nothing behind and every booking has a unique reference", () => {
    const totals = garageTotals();
    expect(totals.bookings).toBe(winners.length);
    expect(totals.reference_count).toBe(winners.length);
    // One transaction per call: the customer and vehicle upserts of a refused call are rolled back.
    expect(totals.customers).toBe(winners.length);
    expect(totals.vehicles).toBe(winners.length);
    expect(totals.created_events).toBe(winners.length);
    const references = winners.map((attempt) => attempt.data!.reference);
    expect(new Set(references).size).toBe(references.length);
    for (const reference of references) expect(reference).toMatch(new RegExp(`^${garage.bookingPrefix}-\\d{4,6}$`));
  });

  it("replaying a winner's idempotency key returns the same booking and books nothing new", async () => {
    const before = garageTotals();
    const replays = await inParallel([...winners, ...winners].map((attempt) => attempt.payload));
    for (const [index, replay] of replays.entries()) {
      const original = winners[index % winners.length]!;
      expect(replay.error).toBeNull();
      expect(replay.data).toEqual({ ...original.data, replayed: true });
    }
    expect(garageTotals()).toEqual(before);
    expect(overlappingPairs()).toEqual([]);
  });

  it("racing copies of one idempotency key book once and all return that booking", async () => {
    const slot = (await slotsOn(raceDay)).find((row) => localTime(row.starts_at) === "12:00");
    expect(slot, `a 12:00 start on ${raceDay}`).toBeDefined();
    const payload = bookingPayload(slot!.starts_at, 900);
    const copies = await inParallel(Array.from({ length: 20 }, () => payload));
    expect(copies.map((copy) => copy.error)).toEqual(copies.map(() => null));
    const ids = new Set(copies.map((copy) => copy.data!.booking_id));
    expect(ids.size).toBe(1);
    expect(copies.filter((copy) => copy.data!.replayed === false)).toHaveLength(1);
    expect(bookingsOn(raceDay)).toHaveLength(1);
    expect((await slotsOn(raceDay)).find((row) => row.starts_at === slot!.starts_at)?.free_count).toBe(ACTIVE_BAYS - 1);
  });
});
