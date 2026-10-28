import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseRange } from "./view";
import type {
  CollectionLeg,
  CourtesyCar,
  CourtesyLoan,
  CourtesyRequest,
  LegKind,
  LegStatus,
  LoanStatus,
} from "./view";

// P5.8 admin reads. Everything goes through the selected garage's RLS client (`admin.client`, which
// sends x-garage-id) and names the garage explicitly; select policies do not check the plan, so a
// garage that moved to Essentials still sees its cars and loans read-only.

type Client = SupabaseClient;

type CarRow = {
  id: string;
  name: string;
  registration: string;
  active: boolean;
  notes: string | null;
  mileage: number | null;
  fuel_eighths: number | null;
  sort: number;
};

type BookingJoin = { reference: string | null; starts_at?: string | null; customer: { name: string | null } | { name: string | null }[] | null } | null;

type LoanRow = {
  id: string;
  car_id: string;
  booking_id: string;
  during: string;
  status: LoanStatus;
  notes: string | null;
  mileage_out: number | null;
  fuel_out: number | null;
  mileage_in: number | null;
  fuel_in: number | null;
  damage_notes: string | null;
  booking?: BookingJoin | BookingJoin[];
};

type LegRow = {
  id: string;
  booking_id: string;
  leg: LegKind;
  status: LegStatus;
  resource_id: string | null;
  during: string;
  postcode: string;
  address: string | null;
  resource?: { name: string | null } | { name: string | null }[] | null;
  booking?: BookingJoin | BookingJoin[];
};

type RequestRow = {
  id: string;
  booking_id: string;
  status: CourtesyRequest["status"];
  free_at_request: boolean;
  created_at: string;
  booking?: BookingJoin | BookingJoin[];
};

export class CourtesyDataError extends Error {}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function bookingFacts(join: LoanRow["booking"]) {
  const booking = one(join ?? null);
  const customer = one(booking?.customer ?? null);
  return { reference: booking?.reference ?? null, customerName: customer?.name ?? null, startsAt: booking?.starts_at ?? null };
}

export function mapCar(row: CarRow): CourtesyCar {
  return {
    id: row.id,
    name: row.name,
    registration: row.registration,
    active: row.active,
    notes: row.notes,
    mileage: row.mileage,
    fuelEighths: row.fuel_eighths,
    sort: row.sort,
  };
}

export function mapLoan(row: LoanRow): CourtesyLoan {
  const { startsAt, endsAt } = parseRange(row.during);
  const facts = bookingFacts(row.booking);
  return {
    id: row.id,
    carId: row.car_id,
    bookingId: row.booking_id,
    startsAt,
    endsAt,
    status: row.status,
    notes: row.notes,
    mileageOut: row.mileage_out,
    fuelOut: row.fuel_out,
    mileageIn: row.mileage_in,
    fuelIn: row.fuel_in,
    damageNotes: row.damage_notes,
    reference: facts.reference,
    customerName: facts.customerName,
  };
}

export function mapLeg(row: LegRow): CollectionLeg {
  const { startsAt, endsAt } = parseRange(row.during);
  const facts = bookingFacts(row.booking);
  return {
    id: row.id,
    bookingId: row.booking_id,
    leg: row.leg,
    status: row.status,
    resourceId: row.resource_id,
    resourceName: one(row.resource ?? null)?.name ?? null,
    startsAt,
    endsAt,
    postcode: row.postcode,
    address: row.address,
    reference: facts.reference,
    customerName: facts.customerName,
  };
}

const CAR_COLUMNS = "id,name,registration,active,notes,mileage,fuel_eighths,sort";
const LOAN_COLUMNS = "id,car_id,booking_id,during,status,notes,mileage_out,fuel_out,mileage_in,fuel_in,damage_notes";
const BOOKING_JOIN = "booking:bookings(reference,starts_at,customer:customers(name))";

export async function loadFleet(client: Client, garageId: string): Promise<CourtesyCar[]> {
  const { data, error } = await client.from("courtesy_cars").select(CAR_COLUMNS).eq("garage_id", garageId).order("sort").order("name");
  if (error) throw new CourtesyDataError(error.message);
  return ((data ?? []) as CarRow[]).map(mapCar);
}

/** Loans overlapping [from, to) (ISO instants), any status but cancelled, with booking reference and customer. */
export async function loadLoansBetween(client: Client, garageId: string, from: string, to: string): Promise<CourtesyLoan[]> {
  const { data, error } = await client
    .from("courtesy_car_loans")
    .select(`${LOAN_COLUMNS},${BOOKING_JOIN}`)
    .eq("garage_id", garageId)
    .neq("status", "cancelled")
    .overlaps("during", `[${from},${to})`)
    .order("during");
  if (error) throw new CourtesyDataError(error.message);
  return ((data ?? []) as unknown as LoanRow[]).map(mapLoan);
}

/** Loans still to be dealt with whatever the week shown: out now, or reserved and starting soon. */
export async function loadLiveLoans(client: Client, garageId: string): Promise<CourtesyLoan[]> {
  const { data, error } = await client
    .from("courtesy_car_loans")
    .select(`${LOAN_COLUMNS},${BOOKING_JOIN}`)
    .eq("garage_id", garageId)
    .in("status", ["reserved", "out"])
    .order("during")
    .limit(200);
  if (error) throw new CourtesyDataError(error.message);
  return ((data ?? []) as unknown as LoanRow[]).map(mapLoan);
}

export async function loadOpenRequests(client: Client, garageId: string): Promise<CourtesyRequest[]> {
  const { data, error } = await client
    .from("courtesy_car_requests")
    .select(`id,booking_id,status,free_at_request,created_at,${BOOKING_JOIN}`)
    .eq("garage_id", garageId)
    .eq("status", "open")
    .order("created_at")
    .limit(50);
  if (error) throw new CourtesyDataError(error.message);
  return ((data ?? []) as unknown as RequestRow[]).map((row) => {
    const facts = bookingFacts(row.booking);
    return {
      id: row.id,
      bookingId: row.booking_id,
      status: row.status,
      freeAtRequest: row.free_at_request,
      createdAt: row.created_at,
      reference: facts.reference,
      customerName: facts.customerName,
      startsAt: facts.startsAt,
    };
  });
}

/** Van legs that are not cancelled, from `from` on (ISO), soonest first. */
export async function loadUpcomingLegs(client: Client, garageId: string, from: string, limit = 50): Promise<CollectionLeg[]> {
  const { data, error } = await client
    .from("collection_delivery_legs")
    .select(`id,booking_id,leg,status,resource_id,during,postcode,address,resource:resources(name),${BOOKING_JOIN}`)
    .eq("garage_id", garageId)
    .neq("status", "cancelled")
    .overlaps("during", `[${from},infinity)`)
    .order("during")
    .limit(limit);
  if (error) throw new CourtesyDataError(error.message);
  return ((data ?? []) as unknown as LegRow[]).map(mapLeg);
}

export type BookingCourtesy = {
  loans: CourtesyLoan[];
  request: CourtesyRequest | null;
  legs: CollectionLeg[];
  cars: CourtesyCar[];
  serviceOffersCollection: boolean;
};

/** Everything the booking page's courtesy panel shows for one booking. */
export async function loadBookingCourtesy(client: Client, garageId: string, bookingId: string): Promise<BookingCourtesy> {
  const [loans, request, legs, cars, service] = await Promise.all([
    client.from("courtesy_car_loans").select(LOAN_COLUMNS).eq("garage_id", garageId).eq("booking_id", bookingId).neq("status", "cancelled").order("during"),
    client
      .from("courtesy_car_requests")
      .select("id,booking_id,status,free_at_request,created_at")
      .eq("garage_id", garageId)
      .eq("booking_id", bookingId)
      .in("status", ["open", "confirmed", "declined"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("collection_delivery_legs")
      .select("id,booking_id,leg,status,resource_id,during,postcode,address,resource:resources(name)")
      .eq("garage_id", garageId)
      .eq("booking_id", bookingId)
      .neq("status", "cancelled")
      .order("leg"),
    client.from("courtesy_cars").select(CAR_COLUMNS).eq("garage_id", garageId).order("sort").order("name"),
    client.from("bookings").select("service:services(collection_delivery)").eq("garage_id", garageId).eq("id", bookingId).maybeSingle(),
  ]);
  for (const result of [loans, request, legs, cars, service]) {
    if (result.error) throw new CourtesyDataError(result.error.message);
  }
  const requestRow = request.data as RequestRow | null;
  return {
    loans: ((loans.data ?? []) as LoanRow[]).map(mapLoan),
    request: requestRow
      ? { id: requestRow.id, bookingId: requestRow.booking_id, status: requestRow.status, freeAtRequest: requestRow.free_at_request, createdAt: requestRow.created_at }
      : null,
    legs: ((legs.data ?? []) as unknown as LegRow[]).map(mapLeg),
    cars: ((cars.data ?? []) as CarRow[]).map(mapCar),
    serviceOffersCollection: Boolean(
      one((service.data as { service?: { collection_delivery?: boolean } | { collection_delivery?: boolean }[] | null } | null)?.service ?? null)?.collection_delivery,
    ),
  };
}

export type CarOption = { carId: string; name: string; registration: string; free: boolean; windowStarts: string; windowEnds: string };

/** `courtesy_car_options()`: each active car and whether it is free for the window (default: the booking's day). */
export async function loadCarOptions(client: Client, bookingId: string, window?: { startsAt: string; endsAt: string } | null): Promise<CarOption[]> {
  const { data, error } = await client.rpc("courtesy_car_options", {
    p_booking_id: bookingId,
    p_starts_at: window?.startsAt ?? null,
    p_ends_at: window?.endsAt ?? null,
  });
  if (error) throw new CourtesyDataError(error.message);
  return ((data ?? []) as Array<{ car_id: string; name: string; registration: string; free: boolean; window_starts: string; window_ends: string }>).map((row) => ({
    carId: row.car_id,
    name: row.name,
    registration: row.registration,
    free: row.free,
    windowStarts: new Date(row.window_starts).toISOString(),
    windowEnds: new Date(row.window_ends).toISOString(),
  }));
}

/**
 * Booking ids (of those given) with a live courtesy car, for the Today and Diary badge. Never throws:
 * the badge is a nicety, so a failed read shows no badges.
 */
export async function courtesyBookingIds(client: Client, garageId: string, bookingIds: string[]): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();
  try {
    const { data, error } = await client
      .from("courtesy_car_loans")
      .select("booking_id")
      .eq("garage_id", garageId)
      .in("booking_id", bookingIds.slice(0, 500))
      .in("status", ["reserved", "out"]);
    if (error) return new Set();
    return new Set(((data ?? []) as Array<{ booking_id: string }>).map((row) => row.booking_id));
  } catch {
    return new Set();
  }
}
