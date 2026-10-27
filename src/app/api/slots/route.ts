import type { NextRequest } from "next/server";
import { z } from "zod";
import { getBookingEngine } from "@/lib/booking-engine";
import { BookingEngineError, bookingErrorMessages, bookingErrorStatus } from "@/lib/booking-engine/errors";
import { errorResponse, jsonResponse, requesterIp, validationIssues } from "@/lib/booking-engine/http";
import { locationModes } from "@/lib/booking-engine/types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { resolveRouteGarage } from "@/lib/tenancy/route";

/** Widest window one request may ask for (local days, inclusive). */
const MAX_SLOT_WINDOW_DAYS = 14;

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a real date");

// Strict: unknown parameters (a garage id, a registration) are rejected, not ignored.
const slotQuerySchema = z.object({
  service: z.string().uuid(),
  from: localDate,
  to: localDate,
  mode: z.enum(locationModes).optional(),
}).strict().superRefine((value, context) => {
  const days = (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0 || days >= MAX_SLOT_WINDOW_DAYS) {
    context.addIssue({ code: "custom", path: ["to"], message: `Choose up to ${MAX_SLOT_WINDOW_DAYS} days, ending on or after the start date` });
  }
});

/** `GET /api/slots?service=&from=&to=&mode=`: every candidate start for the host's garage (`freeCount = 0` is taken). */
export async function GET(request: NextRequest) {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;

  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  // The dev-only garage switch is handled by the proxy, not by this route.
  delete params.__garage;
  const parsed = slotQuerySchema.safeParse(params);
  if (!parsed.success) {
    return errorResponse(422, "INVALID_BOOKING", "Choose a service and a date range of up to 14 days.", { issues: validationIssues(parsed.error) });
  }

  if (!(await consumeRateLimit(`${garage.id}:${requesterIp(request)}`, "booking_slots", 30, 300))) {
    return errorResponse(429, "RATE_LIMITED", "Too many availability requests. Please wait and try again.");
  }

  try {
    const slots = await getBookingEngine().getAvailableSlots({
      garageId: garage.id,
      serviceId: parsed.data.service,
      from: parsed.data.from,
      to: parsed.data.to,
      locationMode: parsed.data.mode,
    });
    return jsonResponse({ slots, timezone: garage.timezone });
  } catch (error) {
    const code = error instanceof BookingEngineError ? error.code : "UNAVAILABLE";
    return errorResponse(bookingErrorStatus[code], code, bookingErrorMessages[code]);
  }
}
