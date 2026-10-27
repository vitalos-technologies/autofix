import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { canChangeStatus, holdsResource } from "@/lib/admin/booking-status";
import { notifyBooking } from "@/lib/booking-engine/notify";
import { clearSlotCache } from "@/lib/booking-engine/slots";
import { bookingStatuses, type BookingStatus } from "@/lib/booking-engine/types";

// Staff changes to a booking, through the garage's RLS client only. Staff may
// update status, notes, admin_seen_at and cancellation_reason on bookings and
// insert `note` events as themselves (docs/autofix/ARCHITECTURE.md, staff
// grants). The status trigger writes the status_changed / cancelled event, so
// nothing here inserts one.

export type StaffActor = {
  /** RLS client for the selected garage (`getAdminContext().client`). */
  client: SupabaseClient;
  garage: { id: string };
  user: { id: string };
};

export type BookingChangeCode = "not_found" | "not_allowed" | "stale" | "invalid" | "failed";

export type StatusChangeResult =
  | { ok: true; from: BookingStatus; to: BookingStatus }
  | { ok: false; code: BookingChangeCode };

export const CHANGE_MESSAGES: Record<BookingChangeCode, string> = {
  not_found: "This booking could not be found.",
  not_allowed: "That change is not possible from the booking's current status.",
  stale: "Someone else changed this booking just now. Check its status and try again.",
  invalid: "Check the details and try again.",
  failed: "The booking could not be changed. Please try again.",
};

function isStatus(value: unknown): value is BookingStatus {
  return typeof value === "string" && (bookingStatuses as readonly string[]).includes(value);
}

/**
 * Moves a booking to `to` if staff may make that change from its current status. The update is
 * conditional on the status read a moment before, so two people pressing at once cannot skip a
 * step. Cancelling tells the customer (as the engine does); releasing the bay clears the slot cache.
 */
export async function changeBookingStatus(
  actor: StaffActor,
  bookingId: string,
  to: BookingStatus,
  options: { reason?: string | null; now?: Date } = {},
): Promise<StatusChangeResult> {
  const { client, garage } = actor;
  const current = await client.from("bookings").select("id,status").eq("id", bookingId).is("deleted_at", null).maybeSingle();
  if (current.error) return { ok: false, code: "failed" };
  const from = (current.data as { status?: unknown } | null)?.status;
  if (!current.data || !isStatus(from)) return { ok: false, code: "not_found" };
  if (!canChangeStatus(from, to)) return { ok: false, code: "not_allowed" };

  const patch: { status: BookingStatus; cancellation_reason?: string } = { status: to };
  if (to === "cancelled") patch.cancellation_reason = options.reason?.trim().slice(0, 300) || "Cancelled by the garage";

  const updated = await client
    .from("bookings")
    .update(patch)
    .eq("garage_id", garage.id)
    .eq("id", bookingId)
    .eq("status", from)
    .select("id,status")
    .maybeSingle();
  if (updated.error) return { ok: false, code: "failed" };
  if (!updated.data) return { ok: false, code: "stale" };

  if (to === "confirmed") {
    // Accepting a request is reviewing it: clear it from the "new booking" alerts.
    await client.from("bookings").update({ admin_seen_at: (options.now ?? new Date()).toISOString() }).eq("garage_id", garage.id).eq("id", bookingId).is("admin_seen_at", null);
  }
  if (!holdsResource(to)) clearSlotCache(garage.id);
  if (to === "cancelled") notifyBooking({ type: "cancelled", garageId: garage.id, bookingId });
  return { ok: true, from, to };
}

export const NOTE_MAX_LENGTH = 1000;

/** Adds a staff note to the booking's timeline (`booking_events` type `note`, actor staff, as the member). */
export async function addBookingNote(actor: StaffActor, bookingId: string, text: string): Promise<{ ok: true } | { ok: false; code: BookingChangeCode }> {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body || body.length > NOTE_MAX_LENGTH) return { ok: false, code: "invalid" };
  const booking = await actor.client.from("bookings").select("id").eq("id", bookingId).is("deleted_at", null).maybeSingle();
  if (booking.error) return { ok: false, code: "failed" };
  if (!booking.data) return { ok: false, code: "not_found" };
  const { error } = await actor.client.from("booking_events").insert({
    garage_id: actor.garage.id,
    booking_id: bookingId,
    type: "note",
    actor: "staff",
    actor_id: actor.user.id,
    data: { text: body },
  });
  return error ? { ok: false, code: "failed" } : { ok: true };
}
