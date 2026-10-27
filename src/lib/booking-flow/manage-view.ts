/**
 * What the manage booking page shows for a booking. Pure and client-safe: no ids, no full phone
 * numbers (the server masks them before anything reaches here).
 */
import type { BookingStatusChipTone } from "@/components/book/booking-status-chip";
import type { BookingStatus, LocationMode } from "@/lib/booking-engine/types";

/**
 * - `open`: confirmed and far enough ahead to change online
 * - `requested`: waiting for the garage's OK, still changeable online
 * - `cutoff`: too close to the start to change online (call the garage)
 * - `in_workshop`: arrived, in the bay, waiting for parts or ready
 * - `past`: the start has gone by (and nobody marked it collected)
 * - `finished`: collected
 * - `cancelled`, `no_show`
 */
export type ManageBookingState = "open" | "requested" | "cutoff" | "in_workshop" | "past" | "finished" | "cancelled" | "no_show";

/** The customer view of a booking (built on the server from the managed booking). */
export type ManageBookingView = {
  reference: string;
  status: BookingStatus;
  state: ManageBookingState;
  startsAt: string;
  endsAt: string;
  /** Online changes close at this instant. */
  changeDeadline: string;
  serviceName: string;
  locationMode: LocationMode;
  registration: string;
  /** "Vauxhall Astra", or empty for a car entered without make or model. */
  vehicleName: string;
  customerName: string;
  /** `07••• •••412`, or null when there is no number. */
  phoneHint: string | null;
};

/** Statuses for a car the garage already has. */
const WITH_GARAGE: readonly BookingStatus[] = ["arrived", "in_progress", "waiting_parts", "ready"];

export function manageBookingState(
  booking: { status: BookingStatus; startsAt: string; canChange: boolean },
  now: Date = new Date(),
): ManageBookingState {
  if (booking.status === "cancelled") return "cancelled";
  if (booking.status === "no_show") return "no_show";
  if (booking.status === "collected") return "finished";
  if (WITH_GARAGE.includes(booking.status)) return "in_workshop";
  if (now.getTime() >= Date.parse(booking.startsAt)) return "past";
  if (!booking.canChange) return "cutoff";
  return booking.status === "requested" ? "requested" : "open";
}

/** Customer wording for the status chip (the admin has its own, shorter labels). */
export const MANAGE_STATUS_CHIPS: Record<BookingStatus, { label: string; tone: BookingStatusChipTone }> = {
  requested: { label: "Awaiting the garage's OK", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  arrived: { label: "Arrived", tone: "info" },
  in_progress: { label: "In the workshop", tone: "info" },
  waiting_parts: { label: "Waiting for parts", tone: "warning" },
  ready: { label: "Ready to collect", tone: "success" },
  collected: { label: "Collected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "danger" },
  no_show: { label: "Missed", tone: "neutral" },
};

/** The chip for a booking: its status, or "Time passed" once a booking that was never started is over. */
export function manageStatusChip(view: Pick<ManageBookingView, "status" | "state">) {
  if (view.state === "past") return { label: "Time passed", tone: "neutral" as BookingStatusChipTone };
  return MANAGE_STATUS_CHIPS[view.status];
}

/** Online changes are open for these states only. */
export function canChangeOnline(state: ManageBookingState) {
  return state === "open" || state === "requested";
}

/** `24` → "24 hours", `48` → "2 days", `1` → "1 hour": the garage's cancellation cutoff in words. */
export function cutoffWindow(hours: number) {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** `?done=` after a change on the manage page. Not personal data. */
export const MANAGE_DONE = ["moved", "cancelled"] as const;
export type ManageDone = (typeof MANAGE_DONE)[number];

/** `?link=` after a signed link that did not open a booking. Not personal data. */
export const MANAGE_LINK_PROBLEMS = ["invalid", "limited", "unavailable"] as const;
export type ManageLinkProblem = (typeof MANAGE_LINK_PROBLEMS)[number];

export function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
}
