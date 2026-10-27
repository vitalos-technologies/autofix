import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_BOOKING_SELECT, toAdminBooking, type AdminBooking, type AdminBookingRow } from "@/lib/admin/bookings";
import { addDays, DEFAULT_TIME_ZONE, localDayRange, startOfLocalDay } from "@/lib/admin/dates";
import type { DiaryResourceRow, MissedCall, OpeningWindow, ReminderWeek, WonBack } from "@/lib/admin/today";
import { bookingStatuses, type BookingStatus } from "@/lib/booking-engine/types";
import { toE164UK } from "@/lib/messaging/phone";

// Reads for the admin pages. Every function takes the garage's RLS client
// (getAdminContext().client, which sends x-garage-id), so a query can only
// ever see the selected garage's rows; none of them uses the service role.

/** Thrown when a read the page needs fails; pages show a "could not load" notice. */
export class AdminDataError extends Error {
  constructor(what: string) {
    super(`Could not load ${what}`);
    this.name = "AdminDataError";
  }
}

export async function loadResources(client: SupabaseClient): Promise<DiaryResourceRow[]> {
  const { data, error } = await client.from("resources").select("id,name,sort").eq("active", true).order("sort", { ascending: true }).order("name", { ascending: true });
  if (error) throw new AdminDataError("bays and vans");
  return ((data ?? []) as Array<{ id: string; name: string }>).map((row) => ({ id: row.id, name: row.name }));
}

/** Bookings starting in `[from, to)` (ISO instants), soonest first. */
export async function loadBookingsStarting(client: SupabaseClient, from: string, to: string): Promise<AdminBooking[]> {
  const { data, error } = await client
    .from("bookings")
    .select(ADMIN_BOOKING_SELECT)
    .is("deleted_at", null)
    .gte("starts_at", from)
    .lt("starts_at", to)
    .order("starts_at", { ascending: true })
    .limit(1000);
  if (error) throw new AdminDataError("bookings");
  return ((data ?? []) as unknown as AdminBookingRow[]).map(toAdminBooking);
}

/** Requests waiting for the garage's OK that have not ended yet, soonest first. */
export async function loadOpenRequests(client: SupabaseClient, now: Date, limit = 20): Promise<{ rows: AdminBooking[]; count: number }> {
  const { data, error, count } = await client
    .from("bookings")
    .select(ADMIN_BOOKING_SELECT, { count: "exact" })
    .is("deleted_at", null)
    .eq("status", "requested")
    .gte("ends_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(limit);
  if (error) throw new AdminDataError("requests");
  const rows = ((data ?? []) as unknown as AdminBookingRow[]).map(toAdminBooking);
  return { rows, count: count ?? rows.length };
}

/** How many requests are waiting for the garage's OK (the Bookings badge). 0 when it cannot tell. */
export async function countOpenRequests(client: SupabaseClient, now = new Date()): Promise<number> {
  const count = await headCount(
    client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "requested").gte("ends_at", now.toISOString()),
  );
  return count ?? 0;
}

/** Opening windows by ISO weekday (1 = Monday). */
export async function loadOpeningHours(client: SupabaseClient): Promise<Map<number, OpeningWindow[]>> {
  const { data, error } = await client.from("opening_hours").select("weekday,opens,closes").order("opens", { ascending: true });
  const byDay = new Map<number, OpeningWindow[]>();
  // Opening hours only size the diary; without them it falls back to 08:00 to 17:00.
  if (error) return byDay;
  for (const row of (data ?? []) as Array<{ weekday: number; opens: string; closes: string }>) {
    byDay.set(row.weekday, [...(byDay.get(row.weekday) ?? []), { opens: row.opens, closes: row.closes }]);
  }
  return byDay;
}

/**
 * Bookings from reminders made this month and what they are worth (`bookings.price_pence`).
 * TODO(P3.6): switch to `reminder_won_back(p_garage_id, p_from, p_to)`, which credits the invoice
 * total when an invoice is linked; until then the booking's price snapshot stands in.
 */
export async function loadWonBack(client: SupabaseClient, monthFirst: string, timeZone = DEFAULT_TIME_ZONE): Promise<WonBack> {
  const [year = 0, month = 1] = monthFirst.split("-").map(Number);
  const nextMonth = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
  const { data, error } = await client
    .from("bookings")
    .select("price_pence,status")
    .is("deleted_at", null)
    .eq("source", "reminder")
    .gte("created_at", startOfLocalDay(monthFirst, timeZone).toISOString())
    .lt("created_at", startOfLocalDay(nextMonth, timeZone).toISOString())
    .limit(5000);
  if (error) return { bookings: 0, pence: 0 };
  const live = ((data ?? []) as Array<{ price_pence: number | null; status: string }>).filter((row) => row.status !== "cancelled" && row.status !== "no_show");
  return { bookings: live.length, pence: live.reduce((total, row) => total + (row.price_pence ?? 0), 0) };
}

async function headCount(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count, error } = await query;
  return error ? null : (count ?? 0);
}

/**
 * Reminders this week (`reminder_sends`, P3.6). `null` until that table exists (or when it cannot
 * be read), so the page shows an empty state instead of zeros.
 */
export async function loadReminderWeek(client: SupabaseClient, from: string, to: string): Promise<ReminderWeek | null> {
  const sends = () => client.from("reminder_sends").select("id", { count: "exact", head: true });
  const [due, sent, booked] = await Promise.all([
    headCount(sends().eq("status", "scheduled").gte("send_at", from).lt("send_at", to)),
    headCount(sends().in("status", ["sent", "delivered"]).gte("sent_at", from).lt("sent_at", to)),
    headCount(client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("source", "reminder").gte("created_at", from).lt("created_at", to)),
  ]);
  if (due === null || sent === null || booked === null) return null;
  return { due, sent, booked };
}

/** Unhandled missed calls (`calls`, P3.6), newest first; `null` until that table exists. */
export async function loadMissedCalls(client: SupabaseClient, limit = 5): Promise<MissedCall[] | null> {
  const { data, error } = await client
    .from("calls")
    .select("id,from_number,created_at")
    .eq("missed", true)
    .is("handled_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return null;
  return ((data ?? []) as Array<{ id: string; from_number: string | null; created_at: string }>)
    .filter((row) => row.from_number)
    .map((row) => ({ id: row.id, fromNumber: row.from_number as string, at: row.created_at }));
}

// ---------------------------------------------------------------------------
// Bookings list
// ---------------------------------------------------------------------------

export const BOOKING_LIST_PAGE_SIZE = 25;

export type BookingListFilters = {
  status?: BookingStatus | null;
  /** Local dates, inclusive, on `starts_at`. */
  from?: string | null;
  to?: string | null;
  /** Reference, customer name, phone or registration (posted, never in the URL). */
  search?: string | null;
  page?: number;
  pageSize?: number;
  timeZone?: string;
};

/** Letters, digits and a few name characters; anything PostgREST filter syntax treats specially goes. */
export function cleanSearch(value: string | null | undefined): string {
  return (value ?? "").replace(/[^\p{L}\p{N} '@.+-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function matchingIds(client: SupabaseClient, search: string) {
  const compact = search.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const phone = /\d{6,}/.test(search.replace(/\s+/g, "")) ? toE164UK(search, { allowLandline: true }) : null;
  const [customersByName, customersByPhone, vehicles] = await Promise.all([
    search.length >= 2 ? client.from("customers").select("id").ilike("name", `%${search}%`).limit(50) : Promise.resolve({ data: [], error: null }),
    phone ? client.from("customers").select("id").eq("phone", phone).limit(10) : Promise.resolve({ data: [], error: null }),
    /^[A-Z0-9]{2,8}$/.test(compact) ? client.from("vehicles").select("id").eq("registration", compact).limit(10) : Promise.resolve({ data: [], error: null }),
  ]);
  if (customersByName.error || customersByPhone.error || vehicles.error) throw new AdminDataError("search results");
  const ids = (rows: unknown) => ((rows ?? []) as Array<{ id: string }>).map((row) => row.id);
  return {
    customers: [...new Set([...ids(customersByName.data), ...ids(customersByPhone.data)])],
    vehicles: ids(vehicles.data),
    // A whole or partial reference: `HRM-1234`, `HRM-12`, or just its digits.
    reference: /^(?:[A-Z]{2,4}-\d{1,6}|\d{3,6})$/.test(search.toUpperCase().replace(/\s+/g, "")) ? search.toUpperCase().replace(/\s+/g, "") : null,
  };
}

export async function listBookings(client: SupabaseClient, filters: BookingListFilters): Promise<{ rows: AdminBooking[]; total: number; page: number; pageSize: number }> {
  const pageSize = filters.pageSize ?? BOOKING_LIST_PAGE_SIZE;
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const timeZone = filters.timeZone ?? DEFAULT_TIME_ZONE;
  let query = client.from("bookings").select(ADMIN_BOOKING_SELECT, { count: "exact" }).is("deleted_at", null);
  if (filters.status && bookingStatuses.includes(filters.status)) query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("starts_at", localDayRange(filters.from, timeZone).from);
  if (filters.to) query = query.lt("starts_at", startOfLocalDay(addDays(filters.to, 1), timeZone).toISOString());

  const search = cleanSearch(filters.search);
  if (search) {
    const ids = await matchingIds(client, search);
    const terms = [
      ...(ids.reference ? [`reference.ilike.*${ids.reference}*`] : []),
      ...(ids.customers.length ? [`customer_id.in.(${ids.customers.join(",")})`] : []),
      ...(ids.vehicles.length ? [`vehicle_id.in.(${ids.vehicles.join(",")})`] : []),
    ];
    if (terms.length === 0) return { rows: [], total: 0, page: 1, pageSize };
    query = query.or(terms.join(","));
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new AdminDataError("bookings");
  return { rows: ((data ?? []) as unknown as AdminBookingRow[]).map(toAdminBooking), total: count ?? 0, page, pageSize };
}

/** Counts for the list's status filter chips. */
export async function countBookingsByStatus(client: SupabaseClient, statuses: readonly BookingStatus[]): Promise<Partial<Record<BookingStatus, number>>> {
  const counts = await Promise.all(
    statuses.map((status) => headCount(client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", status))),
  );
  return Object.fromEntries(statuses.map((status, index) => [status, counts[index] ?? 0]));
}

// ---------------------------------------------------------------------------
// Booking detail
// ---------------------------------------------------------------------------

export type BookingEvent = {
  id: string;
  type: string;
  actor: string;
  actorId: string | null;
  at: string;
  data: Record<string, unknown>;
};

export type BookingDetail = AdminBooking & {
  address: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  events: BookingEvent[];
};

const DETAIL_SELECT = `${ADMIN_BOOKING_SELECT},address,cancellation_reason,cancelled_at,updated_at`;

export async function loadBookingDetail(client: SupabaseClient, id: string): Promise<BookingDetail | null> {
  const [booking, events] = await Promise.all([
    client.from("bookings").select(DETAIL_SELECT).eq("id", id).is("deleted_at", null).maybeSingle(),
    client.from("booking_events").select("id,type,actor,actor_id,at,data").eq("booking_id", id).order("at", { ascending: false }).limit(200),
  ]);
  if (booking.error) throw new AdminDataError("the booking");
  if (!booking.data) return null;
  const row = booking.data as unknown as AdminBookingRow & { address: string | null; cancellation_reason: string | null; cancelled_at: string | null; updated_at: string };
  return {
    ...toAdminBooking(row),
    address: row.address ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    cancelledAt: row.cancelled_at ?? null,
    updatedAt: row.updated_at,
    events: ((events.data ?? []) as Array<{ id: string; type: string; actor: string; actor_id: string | null; at: string; data: unknown }>).map((event) => ({
      id: event.id,
      type: event.type,
      actor: event.actor,
      actorId: event.actor_id,
      at: event.at,
      data: event.data && typeof event.data === "object" && !Array.isArray(event.data) ? (event.data as Record<string, unknown>) : {},
    })),
  };
}
