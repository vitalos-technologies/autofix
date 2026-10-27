import type { NextRequest } from "next/server";
import { bodyErrorResponse, errorResponse, jsonResponse, readJsonBody, requesterIp, validationIssues } from "@/lib/booking-engine/http";
import {
  cancelBooking,
  createManageSession,
  findBookingForManage,
  MANAGE_COOKIE,
  manageCookieOptions,
  readManageSession,
  rescheduleBooking,
  toPublicManagedBooking,
  type ManagedBooking,
} from "@/lib/booking-engine/manage";
import {
  manageActionSchema,
  manageErrorMessages,
  manageErrorStatus,
  manageLookupSchema,
  manageTokenSchema,
  type ManageErrorCode,
} from "@/lib/booking-engine/manage-schema";
import { consumeRateLimit } from "@/lib/rate-limit";
import { resolveRouteGarage } from "@/lib/tenancy/route";

// Manage booking on the garage's host. A signed link (GET ?token=) or
// reference + registration (POST body, never the URL) opens a 30-minute
// httpOnly session cookie bound to the garage and booking; PATCH changes the
// booking that session (or a link token in the body) opens.

function failure(code: ManageErrorCode, extra: Record<string, unknown> = {}) {
  return errorResponse(manageErrorStatus[code], code, manageErrorMessages[code], extra);
}

function withSession(booking: ManagedBooking, status = 200, headers: Record<string, string> = {}) {
  const response = jsonResponse({ booking: toPublicManagedBooking(booking) }, status, headers);
  response.cookies.set(MANAGE_COOKIE, createManageSession(booking.garageId, booking.id), manageCookieOptions());
  return response;
}

function clearSession(response: ReturnType<typeof failure>) {
  response.cookies.set(MANAGE_COOKIE, "", { ...manageCookieOptions(), maxAge: 0 });
  return response;
}

/** `GET ?token=` opens the booking from its signed link; without a token, the current session's booking. */
export async function GET(request: NextRequest) {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  const ip = requesterIp(request);
  const tokenParam = request.nextUrl.searchParams.get("token");

  try {
    if (tokenParam !== null) {
      if (!(await consumeRateLimit(`${garage.id}:${ip}`, "booking_manage_link", 20, 600))) return failure("RATE_LIMITED");
      const token = manageTokenSchema.safeParse(tokenParam);
      const booking = token.success ? await findBookingForManage({ garageId: garage.id, token: token.data }) : null;
      if (!booking) return failure("NOT_FOUND");
      // The link token is in this URL: do not pass it on.
      return withSession(booking, 200, { "Referrer-Policy": "no-referrer" });
    }

    const session = readManageSession(request.cookies.get(MANAGE_COOKIE)?.value, garage.id);
    if (!session) return failure("SESSION_REQUIRED");
    const booking = await findBookingForManage({ garageId: garage.id, bookingId: session.bookingId });
    if (!booking) return clearSession(failure("NOT_FOUND"));
    return jsonResponse({ booking: toPublicManagedBooking(booking) });
  } catch {
    return failure("UNAVAILABLE");
  }
}

/** Reference + registration in the body: finds the booking and opens a manage session. */
export async function POST(request: NextRequest) {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  const ip = requesterIp(request);
  if (!(await consumeRateLimit(`${garage.id}:${ip}`, "booking_lookup_ip", 5, 600))) return failure("RATE_LIMITED");

  const body = await readJsonBody(request);
  if (!body.ok) return bodyErrorResponse(body.status);
  const parsed = manageLookupSchema.safeParse(body.value);
  if (!parsed.success) return failure("INVALID_BOOKING", { issues: validationIssues(parsed.error) });

  const { reference, registration } = parsed.data;
  if (!(await consumeRateLimit(`${garage.id}:${ip}:${reference}:${registration}`, "booking_lookup_details", 5, 900))) return failure("RATE_LIMITED");

  try {
    const booking = await findBookingForManage({ garageId: garage.id, reference, registration });
    return booking ? withSession(booking) : failure("NOT_FOUND");
  } catch {
    return failure("UNAVAILABLE");
  }
}

/** `{ action: "cancel" }` or `{ action: "reschedule", startsAt }` on the session's (or link token's) booking. */
export async function PATCH(request: NextRequest) {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  const ip = requesterIp(request);

  const body = await readJsonBody(request);
  if (!body.ok) return bodyErrorResponse(body.status);
  const parsed = manageActionSchema.safeParse(body.value);
  if (!parsed.success) return failure("INVALID_BOOKING", { issues: validationIssues(parsed.error) });
  const action = parsed.data;

  try {
    let bookingId: string | null = null;
    if (action.token) {
      if (!(await consumeRateLimit(`${garage.id}:${ip}`, "booking_manage_link", 20, 600))) return failure("RATE_LIMITED");
      bookingId = (await findBookingForManage({ garageId: garage.id, token: action.token }))?.id ?? null;
      if (!bookingId) return failure("NOT_FOUND");
    } else {
      bookingId = readManageSession(request.cookies.get(MANAGE_COOKIE)?.value, garage.id)?.bookingId ?? null;
      if (!bookingId) return failure("SESSION_REQUIRED");
    }

    const scope = action.action === "cancel" ? "booking_cancel" : "booking_reschedule";
    if (!(await consumeRateLimit(`${ip}:${bookingId}`, scope, 3, 600))) return failure("RATE_LIMITED");

    const outcome = action.action === "cancel"
      ? await cancelBooking({ garageId: garage.id, bookingId, actor: "customer", reason: action.reason })
      : await rescheduleBooking({ garageId: garage.id, bookingId, startsAt: action.startsAt, actor: "customer" });
    if (!outcome.ok) return failure(outcome.code, outcome.alternatives ? { alternatives: outcome.alternatives } : {});
    return jsonResponse({ booking: toPublicManagedBooking(outcome.booking), changed: outcome.changed });
  } catch {
    return failure("UNAVAILABLE");
  }
}
