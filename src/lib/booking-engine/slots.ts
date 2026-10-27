import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { BookingEngineError, bookingErrorCodeFromDatabase } from "@/lib/booking-engine/errors";
import { isoInstant } from "@/lib/booking-engine/range";
import type { LocationMode, Slot, SlotQuery, StaffSlotQuery } from "@/lib/booking-engine/types";
import { addCalendarDays, calendarDateInTimeZone } from "@/lib/bookings/date";

// Free slots come from `available_slots()` (docs/autofix/ARCHITECTURE.md),
// cached in memory for 30 seconds per server instance. The cache key holds
// every argument; a booking, reschedule or cancellation clears that garage's
// entries so its own next request sees the change.

export const SLOT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES_PER_GARAGE = 500;
/** Longest window one `available_slots()` call may cover (routes allow 14 days). */
export const MAX_SLOT_WINDOW_DAYS = 62;
/** How far ahead alternatives are searched after a lost slot (same as the slots route window). */
export const ALTERNATIVE_WINDOW_DAYS = 14;
/** Longest window one `staff_available_slots()` call may cover (the SQL refuses more than 31 days). */
export const MAX_STAFF_SLOT_WINDOW_DAYS = 31;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const uuid = z.string().uuid();

const slotRowsSchema = z.array(z.object({
  starts_at: z.string(),
  ends_at: z.string(),
  free_count: z.coerce.number().int().min(0),
}));

type CacheEntry = { expiresAt: number; value: Promise<Slot[]> };
const slotCache = new Map<string, Map<string, CacheEntry>>();

/** Drops cached slots for one garage (after a booking change) or for every garage. */
export function clearSlotCache(garageId?: string) {
  if (garageId) slotCache.delete(garageId);
  else slotCache.clear();
}

function cacheKey(query: SlotQuery) {
  return JSON.stringify([query.serviceId, query.from, query.to, query.locationMode ?? null]);
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isRealDate(value: string) {
  if (!isoDate.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function assertValidQuery(query: SlotQuery, maxDays = MAX_SLOT_WINDOW_DAYS - 1) {
  const days = isRealDate(query.from) && isRealDate(query.to) ? daysBetween(query.from, query.to) : Number.NaN;
  if (!uuid.safeParse(query.garageId).success || !uuid.safeParse(query.serviceId).success || !Number.isFinite(days) || days < 0 || days > maxDays) {
    throw new BookingEngineError("INVALID_BOOKING", "Choose a valid service and date range.");
  }
  if (query.locationMode !== undefined && query.locationMode !== "workshop" && query.locationMode !== "mobile") {
    throw new BookingEngineError("INVALID_BOOKING", "Choose a valid location.");
  }
}

function parseSlots(data: unknown): Slot[] {
  const parsed = slotRowsSchema.safeParse(data ?? []);
  if (!parsed.success) throw new BookingEngineError("UNAVAILABLE");
  return parsed.data
    .flatMap((row) => {
      const startsAt = isoInstant(row.starts_at);
      const endsAt = isoInstant(row.ends_at);
      return startsAt && endsAt ? [{ startsAt, endsAt, freeCount: row.free_count }] : [];
    })
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

async function loadSlots(client: SupabaseClient, query: SlotQuery): Promise<Slot[]> {
  const { data, error } = await client.rpc("available_slots", {
    p_garage_id: query.garageId,
    p_service_id: query.serviceId,
    p_from: query.from,
    p_to: query.to,
    p_location_mode: query.locationMode ?? null,
  });
  if (error) throw new BookingEngineError(bookingErrorCodeFromDatabase(error));
  return parseSlots(data);
}

/**
 * Every candidate start for a service and local date range (`freeCount = 0`
 * means taken). Concurrent identical requests share one database call.
 */
export async function fetchAvailableSlots(client: SupabaseClient, query: SlotQuery, now = Date.now()): Promise<Slot[]> {
  assertValidQuery(query);
  let garageCache = slotCache.get(query.garageId);
  const key = cacheKey(query);
  const hit = garageCache?.get(key);
  if (hit && hit.expiresAt > now) return (await hit.value).map((slot) => ({ ...slot }));

  const value = loadSlots(client, query);
  if (!garageCache) {
    garageCache = new Map();
    slotCache.set(query.garageId, garageCache);
  }
  if (garageCache.size >= MAX_CACHE_ENTRIES_PER_GARAGE) {
    const oldest = garageCache.keys().next().value;
    if (oldest !== undefined) garageCache.delete(oldest);
  }
  const entry: CacheEntry = { expiresAt: now + SLOT_CACHE_TTL_MS, value };
  garageCache.set(key, entry);
  try {
    return (await value).map((slot) => ({ ...slot }));
  } catch (error) {
    // Never cache a failure.
    if (slotCache.get(query.garageId)?.get(key) === entry) slotCache.get(query.garageId)?.delete(key);
    throw error;
  }
}

/**
 * The staff time grid (`staff_available_slots()`, service role): services not
 * offered online too, from the start of today with no notice or booking
 * window; opening hours and closures still apply. Never cached, so a member
 * always sees the bay as it is now.
 */
export async function fetchStaffSlots(client: SupabaseClient, query: StaffSlotQuery): Promise<Slot[]> {
  assertValidQuery(query, MAX_STAFF_SLOT_WINDOW_DAYS);
  if (!uuid.safeParse(query.memberId).success) throw new BookingEngineError("INVALID_BOOKING", "Sign in again to book for the garage.");
  const { data, error } = await client.rpc("staff_available_slots", {
    p_garage_id: query.garageId,
    p_service_id: query.serviceId,
    p_from: query.from,
    p_to: query.to,
    p_location_mode: query.locationMode ?? null,
    p_member_id: query.memberId,
  });
  if (error) throw new BookingEngineError(bookingErrorCodeFromDatabase(error));
  return parseSlots(data);
}

/**
 * The nearest free slots to a requested start: the same local day first
 * (closest in time, earlier or later), then the following days in order.
 */
export function nearestFreeSlots(slots: Slot[], requestedStart: string, timeZone: string, limit = 3): Slot[] {
  const target = Date.parse(requestedStart);
  const day = calendarDateInTimeZone(requestedStart, timeZone);
  if (!Number.isFinite(target) || !day) return [];
  const free = slots.filter((slot) => slot.freeCount > 0 && Date.parse(slot.startsAt) !== target);
  const sameDay = free
    .filter((slot) => calendarDateInTimeZone(slot.startsAt, timeZone) === day)
    .sort((left, right) => Math.abs(Date.parse(left.startsAt) - target) - Math.abs(Date.parse(right.startsAt) - target) || left.startsAt.localeCompare(right.startsAt));
  const later = free
    .filter((slot) => (calendarDateInTimeZone(slot.startsAt, timeZone) ?? "") > day)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  return [...sameDay, ...later].slice(0, limit);
}

export type AlternativesQuery = {
  garageId: string;
  serviceId: string;
  locationMode?: LocationMode;
  requestedStart: string;
  timeZone: string;
  now?: Date;
  /** Starts never to offer (a rescheduled booking's current time). */
  exclude?: string[];
  /** A member booking with staff rules: alternatives come from the staff time grid. */
  memberId?: string;
};

/** Fresh (uncached) alternatives after a slot was lost. Never throws: no alternatives is a valid answer. */
export async function findAlternativeSlots(client: SupabaseClient, query: AlternativesQuery): Promise<Slot[]> {
  const requestedDay = calendarDateInTimeZone(query.requestedStart, query.timeZone);
  const today = calendarDateInTimeZone(query.now ?? new Date(), query.timeZone);
  if (!requestedDay || !today) return [];
  const from = requestedDay > today ? requestedDay : today;
  clearSlotCache(query.garageId);
  try {
    const window = {
      garageId: query.garageId,
      serviceId: query.serviceId,
      from,
      to: addCalendarDays(from, ALTERNATIVE_WINDOW_DAYS - 1),
      locationMode: query.locationMode,
    };
    const slots = query.memberId ? await fetchStaffSlots(client, { ...window, memberId: query.memberId }) : await fetchAvailableSlots(client, window);
    const excluded = new Set((query.exclude ?? []).map((value) => Date.parse(value)));
    return nearestFreeSlots(slots.filter((slot) => !excluded.has(Date.parse(slot.startsAt))), query.requestedStart, query.timeZone);
  } catch {
    return [];
  }
}
