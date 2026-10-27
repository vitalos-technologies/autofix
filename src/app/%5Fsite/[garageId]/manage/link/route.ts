import { NextResponse, type NextRequest } from "next/server";
import { requesterIp } from "@/lib/booking-engine/http";
import { createManageSession, findBookingForManage, MANAGE_COOKIE, manageCookieOptions } from "@/lib/booking-engine/manage";
import { manageTokenSchema } from "@/lib/booking-engine/manage-schema";
import type { ManageLinkProblem } from "@/lib/booking-flow/manage-view";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getHostGarage } from "@/lib/tenancy/garage";

// The signed link from the confirmation email (`/manage?token=…`; the manage page hands the token
// to this handler). The token is checked against the host's garage, a 30-minute manage session is
// opened, and the browser is sent straight on to `/manage`: the token never stays in the address
// bar, in history or in a Referer. A link that does not open a booking lands on the lookup form.

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

/** 303 to a path on this host (relative `Location`, so the garage's own domain is kept). */
function seeOther(path: string) {
  return new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: path } });
}

function problem(kind: ManageLinkProblem) {
  const response = seeOther(`/manage?link=${kind}`);
  // Never leave an earlier booking open behind a link that did not work.
  response.cookies.set(MANAGE_COOKIE, "", { ...manageCookieOptions(), maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest, context: { params: Promise<{ garageId: string }> }) {
  const { garageId } = await context.params;
  let garage;
  try {
    garage = await getHostGarage();
  } catch {
    return seeOther("/manage?link=unavailable");
  }
  if (!garage || garage.id !== garageId) return new NextResponse("Not found", { status: 404, headers: HEADERS });

  // The same bucket as GET /api/bookings/manage?token=.
  if (!(await consumeRateLimit(`${garage.id}:${requesterIp(request)}`, "booking_manage_link", 20, 600))) return problem("limited");

  const token = manageTokenSchema.safeParse(request.nextUrl.searchParams.get("token") ?? "");
  if (!token.success) return problem("invalid");

  let booking;
  try {
    booking = await findBookingForManage({ garageId: garage.id, token: token.data });
  } catch {
    return problem("unavailable");
  }
  if (!booking) return problem("invalid");

  const response = seeOther("/manage");
  response.cookies.set(MANAGE_COOKIE, createManageSession(booking.garageId, booking.id), manageCookieOptions());
  return response;
}
