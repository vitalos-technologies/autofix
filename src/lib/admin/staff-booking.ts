import "server-only";

import { z } from "zod";
import { getBookingEngine } from "@/lib/booking-engine";
import { locationModes, type CreateBookingResult } from "@/lib/booking-engine/types";

// Phone and walk-in bookings made by staff in the admin (`/app/bookings/new`).
// The public booking API only ever books `source = online` (a `source` in its
// body is a 422); this is the server-side path for the staff sources. It goes
// through the same engine (`create_booking()`, so the bay is checked and the
// no_overlap constraint still has the last word). The garage is always the
// member's selected garage, passed in by the caller.
//
// Staff rules (DECISIONS A90, A176-A185): the caller also passes the signed-in
// member's user id from the verified session. With it, `create_booking()`
// lets the member book services not offered online, inside the notice period
// (from the start of today), beyond the online window (up to two years) and
// without approval (straight to confirmed). Opening hours and closures still
// apply unless the member ticks `overrideHours`; the service area, MOT switch
// and the bay check always do. The database checks the member belongs to the
// garage.

export const STAFF_SOURCES = ["phone", "walk_in"] as const;
export type StaffSource = (typeof STAFF_SOURCES)[number];

/** The wording staff confirm with the customer; stored as `customers.consent_text` (`consent_source = staff`). */
export const STAFF_CONSENT_WORDING = "The customer agreed, by phone or in person, to reminders when their MOT and service are due.";

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

export const staffBookingSchema = z
  .object({
    source: z.enum(STAFF_SOURCES),
    serviceId: z.string().uuid("Choose a service"),
    startsAt: z.string().datetime({ offset: true, message: "Choose a time" }),
    locationMode: z.enum(locationModes).default("workshop"),
    postcode: optional(10),
    address: optional(300),
    registration: z
      .string()
      .trim()
      .toUpperCase()
      .transform((value) => value.replace(/\s+/g, ""))
      .pipe(z.string().regex(/^[A-Z0-9]{2,8}$/, "Enter the car's registration")),
    make: optional(80),
    model: optional(120),
    customerName: z.string().trim().min(2, "Enter the customer's name").max(120),
    customerPhone: z.string().trim().min(7, "Enter the customer's mobile").max(30),
    customerEmail: z.union([z.literal(""), z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address").max(254))]).optional(),
    reminderConsent: z.boolean().default(false),
    notes: optional(2000),
    /** The member explicitly books outside opening hours or on a closure day. */
    overrideHours: z.boolean().default(false),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type StaffBookingInput = z.infer<typeof staffBookingSchema>;

/**
 * Books a phone or walk-in booking for the garage through the booking engine, with the staff rules
 * for `memberId` (the signed-in member's user id, from the session; never from the form).
 */
export async function createStaffBooking(garageId: string, memberId: string, input: StaffBookingInput): Promise<CreateBookingResult> {
  return getBookingEngine().createBooking(garageId, {
    serviceId: input.serviceId,
    startsAt: input.startsAt,
    locationMode: input.locationMode,
    postcode: input.locationMode === "mobile" ? input.postcode : undefined,
    address: input.locationMode === "mobile" ? input.address : undefined,
    symptoms: [],
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    customer: {
      name: input.customerName,
      phone: input.customerPhone,
      email: input.customerEmail || undefined,
      channel: "sms",
      reminderConsent: input.reminderConsent,
      consentText: input.reminderConsent ? STAFF_CONSENT_WORDING : undefined,
    },
    vehicle: { registration: input.registration, make: input.make, model: input.model },
  }, { staff: { memberId, overrideHours: input.overrideHours } });
}
