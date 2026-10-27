import "server-only";

import { cookies } from "next/headers";
import { BookingEngineError } from "@/lib/booking-engine/errors";
import {
  createManageSession,
  findBookingForManage,
  MANAGE_COOKIE,
  manageCookieOptions,
  readManageSession,
  type ManagedBooking,
} from "@/lib/booking-engine/manage";
import { fetchAvailableSlots } from "@/lib/booking-engine/slots";
import type { Slot } from "@/lib/booking-engine/types";
import { maskMobile } from "@/lib/booking-flow/copy";
import { addDays, dateKeyInZone } from "@/lib/booking-flow/dates";
import { manageBookingState, type ManageBookingView } from "@/lib/booking-flow/manage-view";
import { vehicleName } from "@/lib/booking-flow/vehicle";
import { createAdminClient } from "@/lib/supabase/server";

// Manage booking pages on the garage host (`/manage`, `/manage/reschedule`, `/manage/cancel`).
// The booking comes from the signed `af_manage` session cookie only (set by the reference +
// registration lookup or the signed email link), never from the URL. The cookie is bound to the
// host's garage: one issued for another garage reads as no session.

export type ManageSessionRead =
  /** No manage cookie. */
  | { kind: "none" }
  /** A cookie that no longer opens a booking (expired, tampered or from another garage). */
  | { kind: "expired" }
  /** The session is valid but the booking is gone (deleted by the garage). */
  | { kind: "missing" }
  /** The database could not be read. */
  | { kind: "unavailable" }
  | { kind: "open"; booking: ManagedBooking };

/** The booking the current manage session opens on this garage. */
export async function readManagedBooking(garageId: string, now = new Date()): Promise<ManageSessionRead> {
  const store = await cookies();
  const value = store.get(MANAGE_COOKIE)?.value;
  if (!value) return { kind: "none" };
  const session = readManageSession(value, garageId, now.getTime());
  if (!session) return { kind: "expired" };
  try {
    const booking = await findBookingForManage({ garageId, bookingId: session.bookingId }, now);
    return booking ? { kind: "open", booking } : { kind: "missing" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Opens (or renews) the 30-minute manage session for a booking. Server actions and route handlers only. */
export async function writeManageSession(booking: Pick<ManagedBooking, "garageId" | "id">): Promise<void> {
  const store = await cookies();
  store.set(MANAGE_COOKIE, createManageSession(booking.garageId, booking.id), manageCookieOptions());
}

export async function clearManageSession(): Promise<void> {
  const store = await cookies();
  store.set(MANAGE_COOKIE, "", { ...manageCookieOptions(), maxAge: 0 });
}

/** The customer view: masked phone, display names, the state the page is in. */
export function toManageBookingView(booking: ManagedBooking, now = new Date()): ManageBookingView {
  return {
    reference: booking.reference,
    status: booking.status,
    state: manageBookingState(booking, now),
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    changeDeadline: booking.changeDeadline,
    serviceName: booking.service.name,
    locationMode: booking.locationMode,
    registration: booking.vehicle.registration,
    vehicleName: vehicleName({ make: booking.vehicle.make ?? undefined, model: booking.vehicle.model ?? undefined }),
    customerName: booking.customerName || booking.customerFirstName,
    phoneHint: booking.customerPhone ? maskMobile(booking.customerPhone) : null,
  };
}

/** Days offered when moving a booking (fewer when the service can only be booked a short way ahead). */
export const RESCHEDULE_DAYS = 14;

export type RescheduleSlots =
  | { ok: true; today: string; lastDay: string; slots: Slot[] }
  | { ok: false; reason: "not_online" | "unavailable" };

/**
 * The starts the booking can move to: the same `available_slots()` the booking page and
 * `rescheduleBooking()` use, for the booking's service and location, from today for two weeks.
 */
export async function loadRescheduleSlots(booking: ManagedBooking, now = new Date()): Promise<RescheduleSlots> {
  const client = createAdminClient();
  if (!client) return { ok: false, reason: "unavailable" };
  const today = dateKeyInZone(now, booking.timeZone);
  const lastDay = addDays(today, RESCHEDULE_DAYS - 1);
  try {
    const slots = await fetchAvailableSlots(client, {
      garageId: booking.garageId,
      serviceId: booking.serviceId,
      from: today,
      to: lastDay,
      locationMode: booking.locationMode,
    }, now.getTime());
    return { ok: true, today, lastDay, slots };
  } catch (error) {
    if (error instanceof BookingEngineError && error.code === "SERVICE_UNAVAILABLE") return { ok: false, reason: "not_online" };
    return { ok: false, reason: "unavailable" };
  }
}
