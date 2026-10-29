import type { NextRequest } from "next/server";
import { z } from "zod";
import { getBookingEngine } from "@/lib/booking-engine";
import { bookingErrorMessages, bookingErrorStatus } from "@/lib/booking-engine/errors";
import { bodyErrorResponse, errorResponse, jsonResponse, readJsonBody, requesterIp, validationIssues } from "@/lib/booking-engine/http";
import { manageBookingUrl } from "@/lib/booking-engine/manage";
import { bookingCustomerInputSchema, createBookingInputSchema } from "@/lib/booking-engine/types";
import { toE164UK } from "@/lib/messaging/phone";
import { consumeRateLimit } from "@/lib/rate-limit";
import { resolveRouteGarage } from "@/lib/tenancy/route";
import { verifyTurnstile } from "@/lib/turnstile";

// The body is the booking only. The garage is the request host's; `source` is
// always "online" here and a reminder attribution only ever comes from a
// verified reminder link (server side), so neither may be sent. The schema is
// strict: a garage id (or anything else unexpected) in the body is a 422.
// Offers consent is taken only on the booking page, where the server knows the
// wording the customer saw, so the customer object here has no offers keys
// (they are dropped like any other unknown customer key).
const publicBookingSchema = createBookingInputSchema
  .omit({ source: true, reminderSendId: true, customer: true })
  .extend({
    customer: bookingCustomerInputSchema.omit({ offersConsent: true, offersConsentText: true }),
    turnstileToken: z.string().trim().min(1).max(4096).optional(),
  });

const tooMany = () => errorResponse(429, "RATE_LIMITED", bookingErrorMessages.RATE_LIMITED);

/** Turnstile is enforced whenever its secret is configured. */
function turnstileConfigured() {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

export async function POST(request: NextRequest) {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;

  const ip = requesterIp(request);
  if (!(await consumeRateLimit(ip, "booking_create_ip", 5, 600)) || !(await consumeRateLimit(garage.id, "booking_create_garage", 200, 600))) {
    return tooMany();
  }

  const body = await readJsonBody(request);
  if (!body.ok) return bodyErrorResponse(body.status);
  const parsed = publicBookingSchema.safeParse(body.value);
  if (!parsed.success) {
    return errorResponse(422, "INVALID_BOOKING", bookingErrorMessages.INVALID_BOOKING, { issues: validationIssues(parsed.error) });
  }
  const { turnstileToken, ...booking } = parsed.data;

  if (turnstileConfigured() && !(await verifyTurnstile(turnstileToken, ip))) {
    return errorResponse(403, "TURNSTILE_FAILED", bookingErrorMessages.TURNSTILE_FAILED);
  }

  // Per customer as well (the identifier is hashed before it is stored).
  const phoneKey = toE164UK(booking.customer.phone) ?? booking.customer.phone;
  if (!(await consumeRateLimit(`${garage.id}:${ip}:${phoneKey}`, "booking_create_details", 5, 1_800))) return tooMany();

  const result = await getBookingEngine().createBooking(garage.id, { ...booking, customer: { ...booking.customer, offersConsent: false }, source: "online" });
  if (!result.ok) {
    return errorResponse(bookingErrorStatus[result.code], result.code, result.message, result.alternatives ? { alternatives: result.alternatives } : {});
  }

  const { reference, status, startsAt, endsAt, manageToken } = result.booking;
  return jsonResponse({
    booking: { reference, status, startsAt, endsAt, manageUrl: manageBookingUrl(garage, manageToken) },
    replayed: result.replayed,
  }, result.replayed ? 200 : 201);
}
