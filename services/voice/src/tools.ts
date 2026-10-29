import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { AutofixSession } from "./autofix.js";

// What the desk can do on a call. Each tool but end_call is one call to Pitline's agent tool API with
// the call's token, so bookings go through create_booking() (always a request staff confirm, never
// confirmed by the AI) and every call is audited in agent_call_log. Inputs are checked here as well as
// by Pitline's strict schemas; tool results go back to the model, never to the logs.

export type CallFacts = {
  callSid: string;
  /** The caller's number from Twilio (E.164), or null when withheld. Kept in memory for the booking only. */
  callerNumber: string | null;
  timezone: string;
};

export type ToolOutcome = { content: string; isError: boolean; booked?: boolean; end?: "goodbye" | "voicemail" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SLOTS = 12;

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "available_slots",
    description: "Free start times for one service between two local dates (at most 14 days apart). Call it before offering any time. Offer two or three of the returned times, never others.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        serviceId: { type: "string", description: "id from the service list" },
        from: { type: "string", description: "first local date, YYYY-MM-DD" },
        to: { type: "string", description: "last local date, YYYY-MM-DD" },
      },
      required: ["serviceId", "from", "to"],
    },
  },
  {
    name: "lookup_vehicle",
    description: "Make and model for a UK registration, to confirm the car with the caller. If it is not found, ask for the make and model instead.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { registration: { type: "string" } },
      required: ["registration"],
    },
  },
  {
    name: "create_booking",
    description: "Ask for a booking at one of the times available_slots returned. It is a request the garage confirms; tell the caller that. Needs the caller's name, the registration, and a UK mobile number (the caller's own number is used unless they give another).",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        serviceId: { type: "string" },
        startsAt: { type: "string", description: "startsAt exactly as available_slots returned it" },
        customerName: { type: "string", description: "full name" },
        mobile: { type: ["string", "null"], description: "a UK mobile the caller gave, or null to use the number they are calling from" },
        registration: { type: "string" },
        make: { type: ["string", "null"] },
        model: { type: ["string", "null"] },
        notes: { type: ["string", "null"], description: "what the caller said is wrong or wanted, in a sentence" },
      },
      required: ["serviceId", "startsAt", "customerName", "mobile", "registration", "make", "model", "notes"],
    },
  },
  {
    name: "get_booking",
    description: "Status of an existing booking, by its reference and the car's registration. The desk cannot change or cancel bookings: offer a call back for that.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { reference: { type: "string" }, registration: { type: "string" } },
      required: ["reference", "registration"],
    },
  },
  {
    name: "end_call",
    description: "End the call after you have said goodbye. Use next=voicemail when the caller would rather leave a voice message for the team (say they can leave it after the tone).",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { next: { type: "string", enum: ["goodbye", "voicemail"] } },
      required: ["next"],
    },
  },
];

function str(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** The same request always gets the same key, so a retried booking is not booked twice. */
export function idempotencyKey(callSid: string, serviceId: string, startsAt: string) {
  const hex = createHash("sha256").update(`${callSid}|${serviceId}|${startsAt}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function speakableTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(new Date(iso));
}

function result(status: number, body: unknown, extra: Partial<ToolOutcome> = {}): ToolOutcome {
  return { content: JSON.stringify({ status, ...(body && typeof body === "object" ? body : { body }) }), isError: status >= 400, ...extra };
}

function invalid(message: string): ToolOutcome {
  return { content: JSON.stringify({ status: 422, code: "INVALID_REQUEST", message }), isError: true };
}

export async function runTool(name: string, input: Record<string, unknown>, session: AutofixSession, facts: CallFacts): Promise<ToolOutcome> {
  switch (name) {
    case "available_slots": {
      const serviceId = str(input.serviceId, 36);
      const from = str(input.from, 10);
      const to = str(input.to, 10);
      if (!serviceId || !UUID.test(serviceId) || !from || !DATE.test(from) || !to || !DATE.test(to)) return invalid("Use a service id from the list and YYYY-MM-DD dates.");
      const response = await session.tool("available_slots", { serviceId, from, to });
      const body = response.body as { slots?: Array<{ startsAt: string }> } | null;
      if (response.status !== 200 || !Array.isArray(body?.slots)) return result(response.status, response.body);
      const slots = body.slots.slice(0, MAX_SLOTS).map((slot) => ({ startsAt: slot.startsAt, say: speakableTime(slot.startsAt, facts.timezone) }));
      return result(200, { slots, more: body.slots.length > MAX_SLOTS });
    }
    case "lookup_vehicle": {
      const registration = str(input.registration, 12);
      if (!registration) return invalid("Ask for the registration.");
      const response = await session.tool("lookup_vehicle", { registration });
      return result(response.status, response.body);
    }
    case "create_booking": {
      const serviceId = str(input.serviceId, 36);
      const startsAt = str(input.startsAt, 40);
      const name = str(input.customerName, 120);
      const registration = str(input.registration, 12);
      const phone = str(input.mobile, 30) ?? facts.callerNumber;
      if (!serviceId || !UUID.test(serviceId) || !startsAt || Number.isNaN(Date.parse(startsAt))) return invalid("Pick a time available_slots returned.");
      if (!name || name.length < 2) return invalid("Ask for the caller's full name.");
      if (!registration) return invalid("Ask for the registration.");
      if (!phone) return invalid("The number is withheld: ask for a UK mobile number.");
      const notes = str(input.notes, 500);
      const vehicle: Record<string, unknown> = { registration };
      const make = str(input.make, 80);
      const model = str(input.model, 120);
      if (make) vehicle.make = make;
      if (model) vehicle.model = model;
      const response = await session.tool("create_booking", {
        serviceId,
        startsAt,
        locationMode: "workshop",
        customer: { name, phone, channel: "sms" },
        vehicle,
        ...(notes ? { notes: `Booked by phone with the AI front desk. ${notes}` } : { notes: "Booked by phone with the AI front desk." }),
        idempotencyKey: idempotencyKey(facts.callSid, serviceId, startsAt),
      });
      const booked = response.status === 200 || response.status === 201;
      const body = response.body as { booking?: { reference?: string; startsAt?: string; status?: string } } | null;
      if (booked && body?.booking?.startsAt) {
        return result(response.status, { booking: { ...body.booking, say: speakableTime(body.booking.startsAt, facts.timezone) }, note: "This is a request: the garage will confirm it by text." }, { booked: true });
      }
      return result(response.status, response.body);
    }
    case "get_booking": {
      const reference = str(input.reference, 20);
      const registration = str(input.registration, 12);
      if (!reference || !registration) return invalid("Ask for the booking reference and the registration.");
      const response = await session.tool("get_booking", { reference, registration });
      return result(response.status, response.body);
    }
    case "end_call":
      return { content: JSON.stringify({ status: 200, ending: true }), isError: false, end: input.next === "voicemail" ? "voicemail" : "goodbye" };
    default:
      return invalid("Unknown tool.");
  }
}
