/**
 * Manage booking contract (`/api/bookings/manage`, the `/manage` page).
 * Client-safe: schemas and the customer-facing view only.
 */
import { z } from "zod";
import type { BookingStatus, LocationMode, Slot } from "@/lib/booking-engine/types";
import { registrationSchema } from "@/lib/vehicle/registration";

/** `<booking_prefix>-NNNN` (4 to 6 digits). Unique per garage only: always look it up with the host's garage. */
export const bookingReferenceSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}-\d{4,6}$/, "Enter your booking reference, for example HRM-4821");

/** Reference + registration, sent in a POST body (never a URL). */
export const manageLookupSchema = z.object({
  reference: bookingReferenceSchema,
  registration: registrationSchema,
}).strict();
export type ManageLookupInput = z.infer<typeof manageLookupSchema>;

/** The signed link token: 32 bytes, base64url. */
export const manageTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link is not valid");

export const manageActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("cancel"),
    reason: z.string().trim().max(300).optional(),
    token: manageTokenSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal("reschedule"),
    startsAt: z.string().datetime({ offset: true }),
    token: manageTokenSchema.optional(),
  }).strict(),
]);
export type ManageActionInput = z.infer<typeof manageActionSchema>;

export const manageErrorCodes = ["NOT_FOUND", "SESSION_REQUIRED", "NOT_MODIFIABLE", "CUTOFF_PASSED", "SLOT_UNAVAILABLE", "INVALID_BOOKING", "RATE_LIMITED", "UNAVAILABLE"] as const;
export type ManageErrorCode = (typeof manageErrorCodes)[number];

export const manageErrorMessages: Record<ManageErrorCode, string> = {
  NOT_FOUND: "We couldn't find a booking matching those details. Please check them and try again.",
  SESSION_REQUIRED: "Your secure booking session has expired. Find your booking again.",
  NOT_MODIFIABLE: "This booking can no longer be changed online. Please contact the garage.",
  CUTOFF_PASSED: "This booking is too close to change online. Please contact the garage.",
  SLOT_UNAVAILABLE: "That time has just been taken. Please choose another time.",
  INVALID_BOOKING: "Please choose a valid time and try again.",
  RATE_LIMITED: "Too many attempts. Please wait a few minutes and try again.",
  UNAVAILABLE: "Booking changes are temporarily unavailable. Please try again shortly.",
};

export const manageErrorStatus: Record<ManageErrorCode, number> = {
  NOT_FOUND: 404,
  SESSION_REQUIRED: 401,
  NOT_MODIFIABLE: 409,
  CUTOFF_PASSED: 409,
  SLOT_UNAVAILABLE: 409,
  INVALID_BOOKING: 422,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

/** What a customer sees about their booking. No ids, phone numbers or email addresses. */
export type PublicManagedBooking = {
  reference: string;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  locationMode: LocationMode;
  service: { id: string; name: string };
  vehicle: { registration: string; make: string | null; model: string | null };
  customerFirstName: string;
  /** The customer may reschedule or cancel online now. */
  canChange: boolean;
  /** Online changes close at this instant (start minus the garage's cancellation cutoff). */
  changeDeadline: string;
  /** Why online changes are closed, when they are. */
  blockedReason: "status" | "cutoff" | null;
};

export type ManageResult =
  | { ok: true; booking: PublicManagedBooking }
  | { ok: false; code: ManageErrorCode; message: string; alternatives?: Slot[] };
