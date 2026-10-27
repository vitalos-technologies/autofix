/**
 * Which status changes staff can make on a booking, and what the buttons say. Pure; the server
 * actions enforce the same table before they update `bookings.status` through the RLS client
 * (the database trigger then writes the `status_changed` / `cancelled` timeline event).
 *
 * The workshop path: requested → confirmed → arrived → in_progress ⇄ waiting_parts → ready →
 * collected. A booking that has not started can be cancelled or marked a no-show; a car in the
 * workshop can still be cancelled (the customer took it away). Cancelled, no-show and collected
 * bookings are finished: reopening one would need the bay re-checked, which only the booking
 * engine can do.
 */
import type { BookingStatus } from "@/lib/booking-engine/types";

export const STAFF_STATUS_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["arrived", "in_progress", "no_show", "cancelled"],
  arrived: ["in_progress", "cancelled"],
  in_progress: ["waiting_parts", "ready", "cancelled"],
  waiting_parts: ["in_progress", "ready", "cancelled"],
  ready: ["collected", "in_progress"],
  collected: [],
  cancelled: [],
  no_show: [],
};

/** Statuses staff can move a booking to from `from`. */
export function nextStatuses(from: BookingStatus): readonly BookingStatus[] {
  return STAFF_STATUS_TRANSITIONS[from] ?? [];
}

export function canChangeStatus(from: BookingStatus, to: BookingStatus): boolean {
  return from !== to && nextStatuses(from).includes(to);
}

/** Finished bookings: no more status changes. */
export function isFinished(status: BookingStatus): boolean {
  return nextStatuses(status).length === 0;
}

/** Bookings still holding their bay (the `no_overlap` constraint ignores the rest). */
export function holdsResource(status: BookingStatus): boolean {
  return status !== "cancelled" && status !== "no_show";
}

/** Cars at the garage now. */
export const IN_WORKSHOP: readonly BookingStatus[] = ["arrived", "in_progress", "waiting_parts"];

/** Button label for moving a booking to `to` (from `from`). */
export function statusActionLabel(to: BookingStatus, from?: BookingStatus): string {
  switch (to) {
    case "confirmed":
      return "Accept";
    case "arrived":
      return "Car arrived";
    case "in_progress":
      return from === "waiting_parts" ? "Parts in, back in the bay" : from === "ready" ? "Back in the bay" : "Start work";
    case "waiting_parts":
      return "Waiting for parts";
    case "ready":
      return "Mark ready";
    case "collected":
      return "Collected";
    case "no_show":
      return "No-show";
    case "cancelled":
      return from === "requested" ? "Decline" : "Cancel booking";
    default:
      return "Change status";
  }
}

/** Short past-tense line for messages after a change ("Marked ready"). */
export function statusChangedMessage(to: BookingStatus): string {
  switch (to) {
    case "confirmed":
      return "Booking accepted.";
    case "arrived":
      return "Marked as arrived.";
    case "in_progress":
      return "Marked as in the bay.";
    case "waiting_parts":
      return "Marked as waiting for parts.";
    case "ready":
      return "Marked ready to collect.";
    case "collected":
      return "Marked as collected.";
    case "no_show":
      return "Marked as a no-show.";
    case "cancelled":
      return "Booking cancelled.";
    default:
      return "Status changed.";
  }
}

/**
 * The forward step(s) worth a one-tap button on the phone job card, in order (the rest stay on the
 * booking page): e.g. `in_progress` → Waiting for parts, Mark ready.
 */
export function quickStatusActions(from: BookingStatus): BookingStatus[] {
  switch (from) {
    case "confirmed":
      return ["arrived"];
    case "arrived":
      return ["in_progress"];
    case "in_progress":
      return ["waiting_parts", "ready"];
    case "waiting_parts":
      return ["in_progress", "ready"];
    case "ready":
      return ["collected"];
    default:
      return [];
  }
}

/** Short label for a job card button (three fit across a phone). */
export function quickActionLabel(to: BookingStatus, from: BookingStatus): string {
  switch (to) {
    case "arrived":
      return "Arrived";
    case "in_progress":
      return from === "waiting_parts" ? "Parts in" : "Start work";
    case "waiting_parts":
      return "Waiting parts";
    default:
      return statusActionLabel(to, from);
  }
}

/** Destructive changes ask for a reason / confirmation on the booking page. */
export function isDestructive(to: BookingStatus): boolean {
  return to === "cancelled" || to === "no_show";
}
