/**
 * Booking engine errors. Client-safe (no server imports) so booking pages can
 * show the same wording as the API. Database messages never reach a customer:
 * every code maps to fixed copy here.
 */
import type { BookingErrorCode } from "@/lib/booking-engine/types";

/** Codes `create_booking()` / `available_slots()` raise with errcode P0001 (message starts with the code). */
const databaseRaisedCodes = ["SLOT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "OUTSIDE_SERVICE_AREA", "INVALID_BOOKING"] as const satisfies readonly BookingErrorCode[];

export const bookingErrorMessages: Record<BookingErrorCode, string> = {
  SLOT_UNAVAILABLE: "That time has just been taken. Please choose another time.",
  SERVICE_UNAVAILABLE: "This service can't be booked online at the moment.",
  OUTSIDE_SERVICE_AREA: "That postcode is outside the area this garage covers for mobile visits.",
  INVALID_BOOKING: "Please check the booking details and try again.",
  RATE_LIMITED: "Too many attempts. Please wait a few minutes and try again.",
  TURNSTILE_FAILED: "We couldn't verify this request. Please try again.",
  UNAVAILABLE: "Online booking is temporarily unavailable. Please try again shortly.",
};

/** HTTP status for each engine code, shared by every booking route. */
export const bookingErrorStatus: Record<BookingErrorCode, number> = {
  SLOT_UNAVAILABLE: 409,
  SERVICE_UNAVAILABLE: 422,
  OUTSIDE_SERVICE_AREA: 422,
  INVALID_BOOKING: 422,
  RATE_LIMITED: 429,
  TURNSTILE_FAILED: 403,
  UNAVAILABLE: 503,
};

export class BookingEngineError extends Error {
  constructor(readonly code: BookingErrorCode, message: string = bookingErrorMessages[code]) {
    super(message);
    this.name = "BookingEngineError";
  }
}

type DatabaseError = { code?: string | null; message?: string | null } | null | undefined;

/**
 * Maps a PostgREST/Postgres error to an engine code:
 * - `P0001` raised by our SQL with a message starting with a code;
 * - `23P01` (the `no_overlap` exclusion constraint) is a lost race for the slot;
 * - invalid input and check violations are the caller's data;
 * - anything else is an outage, never shown in detail.
 */
export function bookingErrorCodeFromDatabase(error: DatabaseError): BookingErrorCode {
  if (!error) return "UNAVAILABLE";
  if (error.code === "P0001") {
    const message = (error.message ?? "").trim().toUpperCase();
    return databaseRaisedCodes.find((code) => message.startsWith(code)) ?? "UNAVAILABLE";
  }
  if (error.code === "23P01") return "SLOT_UNAVAILABLE";
  if (error.code === "22P02" || error.code === "22007" || error.code === "22008" || error.code === "23514" || error.code === "23502") return "INVALID_BOOKING";
  return "UNAVAILABLE";
}
