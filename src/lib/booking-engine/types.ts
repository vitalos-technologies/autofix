/**
 * Booking engine contract (docs/autofix/ARCHITECTURE.md → Booking engine).
 * Shared by the SQL-backed repository (api lane), the booking pages (ui lane)
 * and the agent tool API. Client-safe: no server imports.
 */
import { z } from "zod";

export const locationModes = ["workshop", "mobile"] as const;
export type LocationMode = (typeof locationModes)[number];

export const serviceLocationModes = ["workshop", "mobile", "both"] as const;
export type ServiceLocationMode = (typeof serviceLocationModes)[number];

export const priceModes = ["fixed", "from", "quote"] as const;
export type PriceMode = (typeof priceModes)[number];

export const bookingStatuses = [
  "requested", "confirmed", "arrived", "in_progress", "waiting_parts", "ready", "collected", "cancelled", "no_show",
] as const;
export type BookingStatus = (typeof bookingStatuses)[number];

/** Statuses that no longer hold a resource (outside the `no_overlap` constraint). */
export const releasedStatuses: readonly BookingStatus[] = ["cancelled", "no_show"];

export const bookingSources = ["online", "phone", "walk_in", "reminder", "missed_call", "ai_agent"] as const;
export type BookingSource = (typeof bookingSources)[number];

export const messageChannels = ["sms", "whatsapp", "email"] as const;
export type CustomerChannel = (typeof messageChannels)[number];

/** A service the customer can pick on the booking page. */
export type OnlineService = {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  bufferMin: number;
  pricePence: number | null;
  priceMode: PriceMode;
  locationMode: ServiceLocationMode;
  isMot: boolean;
  needsApproval: boolean;
  minNoticeH: number;
  maxDaysAhead: number;
  sort: number;
};

/** One candidate start from `available_slots()`; `freeCount = 0` means taken. */
export type Slot = { startsAt: string; endsAt: string; freeCount: number };

export type SlotQuery = {
  garageId: string;
  serviceId: string;
  /** Local dates (garage time zone), inclusive, `YYYY-MM-DD`. */
  from: string;
  to: string;
  locationMode?: LocationMode;
};

export const bookingErrorCodes = [
  "SLOT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "OUTSIDE_SERVICE_AREA", "INVALID_BOOKING", "RATE_LIMITED", "TURNSTILE_FAILED", "UNAVAILABLE",
] as const;
export type BookingErrorCode = (typeof bookingErrorCodes)[number];

const registration = z.string().trim().toUpperCase().transform((value) => value.replace(/\s+/g, "")).pipe(z.string().regex(/^[A-Z0-9]{2,8}$/, "Enter a valid registration"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const bookingVehicleInputSchema = z.object({
  registration,
  make: z.string().trim().max(80).optional(),
  model: z.string().trim().max(120).optional(),
  colour: z.string().trim().max(50).optional(),
  fuel: z.string().trim().max(50).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  engine: z.string().trim().max(80).optional(),
  motExpiry: isoDate.optional(),
  lastMileage: z.number().int().min(0).max(2_000_000).optional(),
});
export type BookingVehicleInput = z.infer<typeof bookingVehicleInputSchema>;

export const bookingCustomerInputSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(120),
  /** Any UK mobile format; the server normalises to E.164 and rejects non-mobiles. */
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  channel: z.enum(messageChannels).default("sms"),
  reminderConsent: z.boolean().default(false),
  /**
   * The exact consent wording the customer ticked, stored as `customers.consent_text` (PECR record).
   * Only sent when `reminderConsent` is true.
   */
  consentText: z.string().trim().min(1).max(300).optional(),
});
export type BookingCustomerInput = z.infer<typeof bookingCustomerInputSchema>;

/** Input to `createBooking`. The garage never comes from here: it is the host's garage. */
export const createBookingInputSchema = z.object({
  serviceId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  locationMode: z.enum(locationModes).default("workshop"),
  postcode: z.string().trim().toUpperCase().max(10).optional(),
  address: z.string().trim().max(300).optional(),
  symptoms: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  notes: z.string().trim().max(2000).optional(),
  customer: bookingCustomerInputSchema,
  vehicle: bookingVehicleInputSchema,
  idempotencyKey: z.string().uuid(),
  source: z.enum(bookingSources).default("online"),
  /** Set server-side from a verified reminder link token, never from the client body. */
  reminderSendId: z.string().uuid().optional(),
}).strict();
export type CreateBookingInput = z.infer<typeof createBookingInputSchema>;

export type CreatedBooking = {
  id: string;
  reference: string;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  customerId: string;
  vehicleId: string;
  /** Raw manage token for the confirmation link; only its hash is stored. */
  manageToken: string;
};

export type CreateBookingResult =
  | { ok: true; booking: CreatedBooking; replayed: boolean }
  | { ok: false; code: BookingErrorCode; message: string; alternatives?: Slot[] };

/** Booking flow state kept in the sealed `af_booking` cookie between steps. */
export type BookingDraft = {
  v: 1;
  garageId: string;
  vehicle?: BookingVehicleInput & { manual?: boolean };
  serviceId?: string;
  locationMode?: LocationMode;
  postcode?: string;
  address?: string;
  symptoms?: string[];
  note?: string;
  startsAt?: string;
  /** From a verified `/r/{token}` link (P3.9). */
  reminderSendId?: string;
  /** Stable per draft so a double-submitted Confirm creates one booking. */
  idempotencyKey?: string;
};

/**
 * A member of the garage booking on the customer's behalf (phone / walk-in, DECISIONS A90, A176-A185).
 * Server-set from the verified admin session, never from a request body: it is a separate argument so
 * it can never ride in on `createBookingInputSchema`, which the public and agent APIs derive from.
 */
export const staffBookingContextSchema = z.object({
  /** The signed-in member's user id; `create_booking()` checks they belong to the garage. */
  memberId: z.string().uuid(),
  /** The member explicitly booked outside opening hours or on a closure day. */
  overrideHours: z.boolean().default(false),
}).strict();
export type StaffBookingContext = z.input<typeof staffBookingContextSchema>;

export type CreateBookingOptions = {
  /**
   * Staff rules for a `phone` / `walk_in` booking: services not offered online, no notice or booking
   * window (from the start of today, up to two years ahead), confirmed without approval. Opening
   * hours and closures still apply unless `overrideHours`; the bay check and `no_overlap` always do.
   */
  staff?: StaffBookingContext;
};

/** The staff time grid for one member (`staff_available_slots()`, at most 31 days). */
export type StaffSlotQuery = SlotQuery & { memberId: string };

export interface BookingEngine {
  listOnlineServices(garageId: string): Promise<OnlineService[]>;
  getAvailableSlots(query: SlotQuery): Promise<Slot[]>;
  /** Like `getAvailableSlots`, with the staff rules of `CreateBookingOptions.staff` (opening hours and closures apply). */
  getStaffSlots(query: StaffSlotQuery): Promise<Slot[]>;
  createBooking(garageId: string, input: CreateBookingInput, options?: CreateBookingOptions): Promise<CreateBookingResult>;
}
