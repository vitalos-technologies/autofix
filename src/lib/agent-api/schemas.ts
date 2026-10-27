/**
 * Agent tool API contract (`/api/agent/v1/*`, docs/autofix/agent-api.yaml).
 * Request schemas are the ones the routes enforce; response types mirror the
 * OpenAPI components, and the contract tests validate real handler responses
 * against that file. Client-safe: no server imports.
 */
import { z } from "zod";
import { manageLookupSchema } from "@/lib/booking-engine/manage-schema";
import { bookingVehicleInputSchema, createBookingInputSchema, locationModes, messageChannels, type BookingStatus, type LocationMode, type PriceMode, type ServiceLocationMode } from "@/lib/booking-engine/types";
import { registrationSchema } from "@/lib/vehicle/registration";

export const agentTools = ["lookup_vehicle", "list_services", "available_slots", "create_booking", "get_booking", "garage_profile"] as const;
export type AgentTool = (typeof agentTools)[number];

export function isAgentTool(value: unknown): value is AgentTool {
  return typeof value === "string" && (agentTools as readonly string[]).includes(value);
}

export const agentErrorCodes = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "GARAGE_INACTIVE",
  "NOT_FOUND",
  "VEHICLE_NOT_FOUND",
  "SLOT_UNAVAILABLE",
  "INVALID_REQUEST",
  "INVALID_BOOKING",
  "SERVICE_UNAVAILABLE",
  "OUTSIDE_SERVICE_AREA",
  "INVALID_JSON",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "UNAVAILABLE",
] as const;
export type AgentErrorCode = (typeof agentErrorCodes)[number];

export const agentErrorStatus: Record<AgentErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  GARAGE_INACTIVE: 403,
  NOT_FOUND: 404,
  VEHICLE_NOT_FOUND: 404,
  SLOT_UNAVAILABLE: 409,
  INVALID_REQUEST: 422,
  INVALID_BOOKING: 422,
  SERVICE_UNAVAILABLE: 422,
  OUTSIDE_SERVICE_AREA: 422,
  INVALID_JSON: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

/** Fixed wording per code. Agents may read it out; it never echoes the request. */
export const agentErrorMessages: Record<AgentErrorCode, string> = {
  UNAUTHORIZED: "Send a valid agent token as a bearer token.",
  FORBIDDEN: "This token may not call this tool.",
  GARAGE_INACTIVE: "This garage is not taking bookings at the moment.",
  NOT_FOUND: "No booking matches that reference and registration.",
  VEHICLE_NOT_FOUND: "That vehicle could not be found. Take the make and model from the customer instead.",
  SLOT_UNAVAILABLE: "That time is no longer free. Offer one of the alternatives.",
  INVALID_REQUEST: "The request does not match the tool's input schema.",
  INVALID_BOOKING: "The booking details are not valid. Check them with the customer.",
  SERVICE_UNAVAILABLE: "That service cannot be booked at the moment.",
  OUTSIDE_SERVICE_AREA: "That postcode is outside the area this garage covers for mobile visits.",
  INVALID_JSON: "The request body is not valid JSON.",
  PAYLOAD_TOO_LARGE: "The request is too large.",
  UNSUPPORTED_MEDIA_TYPE: "Send the request body as application/json.",
  RATE_LIMITED: "Too many requests. Wait and try again.",
  UNAVAILABLE: "The garage system is temporarily unavailable. Offer a callback from the garage.",
};

export type AgentIssue = { path: string; message: string };
export type AgentError = { code: AgentErrorCode; message: string; issues?: AgentIssue[]; alternatives?: AgentSlot[] };

// ---------------------------------------------------------------------------
// Requests (POST JSON bodies; registrations never go in a URL)
// ---------------------------------------------------------------------------

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a real date");

/** Widest window one `available_slots` call may ask for (local days, inclusive). */
export const AGENT_MAX_SLOT_DAYS = 14;

export const emptyInputSchema = z.object({}).strict();

export const lookupVehicleInputSchema = z.object({ registration: registrationSchema }).strict();

export const availableSlotsInputSchema = z.object({
  serviceId: z.string().uuid(),
  from: localDate,
  to: localDate,
  locationMode: z.enum(locationModes).optional(),
}).strict().superRefine((value, context) => {
  const days = (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0 || days >= AGENT_MAX_SLOT_DAYS) {
    context.addIssue({ code: "custom", path: ["to"], message: `Ask for up to ${AGENT_MAX_SLOT_DAYS} days, ending on or after the start date` });
  }
});

/**
 * The agent's customer: no reminder consent. Marketing and reminder consent
 * (PECR) is captured by the customer themself on the booking page or by staff,
 * never inferred from a conversation with an AI agent.
 */
export const agentCustomerInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  channel: z.enum(messageChannels).default("sms"),
}).strict();

/** `create_booking`: the engine's input without `source`/`reminderSendId` (set server side) and without consent. */
export const agentCreateBookingInputSchema = createBookingInputSchema
  .omit({ source: true, reminderSendId: true, customer: true, vehicle: true })
  .extend({ customer: agentCustomerInputSchema, vehicle: bookingVehicleInputSchema.strict() })
  .strict();
export type AgentCreateBookingInput = z.infer<typeof agentCreateBookingInputSchema>;

export const getBookingInputSchema = manageLookupSchema;

export const agentInputSchemas = {
  lookup_vehicle: lookupVehicleInputSchema,
  list_services: emptyInputSchema,
  available_slots: availableSlotsInputSchema,
  create_booking: agentCreateBookingInputSchema,
  get_booking: getBookingInputSchema,
  garage_profile: emptyInputSchema,
} as const satisfies Record<AgentTool, z.ZodType>;

// ---------------------------------------------------------------------------
// Responses (components in docs/autofix/agent-api.yaml)
// ---------------------------------------------------------------------------

export type AgentVehicle = {
  registration: string;
  make: string | null;
  model: string | null;
  derivative: string | null;
  year: number | null;
  colour: string | null;
  fuelType: string | null;
  /** Present only when the garage shows MOT data (`garages.mot_enabled`). */
  motStatus?: string | null;
  motExpiry?: string | null;
};

export type AgentService = {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  priceMode: PriceMode;
  /** Published price in pence; null when the garage quotes. Never estimate one. */
  pricePence: number | null;
  /** What to say: "£45.00", "from £45.00" or "Price on quote". */
  priceText: string;
  locationMode: ServiceLocationMode;
  isMot: boolean;
  minNoticeHours: number;
  maxDaysAhead: number;
};

export type AgentSlot = { startsAt: string; endsAt: string };

export type AgentCreatedBooking = { reference: string; status: BookingStatus; startsAt: string; endsAt: string };

export type AgentBookingStatus = {
  reference: string;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  locationMode: LocationMode;
  service: { name: string };
  vehicle: { make: string | null; model: string | null };
  customerFirstName: string;
  canChangeOnline: boolean;
  changeDeadline: string;
};

export type AgentGarageProfile = {
  garage: {
    name: string;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    address: { line1: string | null; line2: string | null; town: string | null; postcode: string | null };
    timezone: string;
    bookingUrl: string;
    motEnabled: boolean;
  };
  openingHours: Array<{ weekday: number; day: string; opens: string; closes: string }>;
  closures: Array<{ startsOn: string; endsOn: string; reason: string | null }>;
  policies: {
    cancellationCutoffHours: number;
    agentBookingsNeedConfirmation: true;
    onlineBookingsNeedApproval: boolean;
    mobileServiceArea: string[];
    humanCallbackAvailable: true;
  };
  faqs: Array<{ question: string; answer: string }>;
};
