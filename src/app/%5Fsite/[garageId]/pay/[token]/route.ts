import { NextResponse } from "next/server";
import { requesterIp } from "@/lib/booking-engine/http";
import { loadPaymentByToken } from "@/lib/payments/server";
import { isPayTokenShape, PAY_COOKIE, payCookieOptions } from "@/lib/payments/tokens";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getHostGarage } from "@/lib/tenancy/garage";

// Pay links (`/pay/{token}` on the garage host, P5.4): the token moves into the httpOnly `af_pay`
// cookie and the customer lands on /pay, so it never stays in the address bar, history or a Referer.
// An unknown token lands on /pay?link=invalid.

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } as const;

function seeOther(path: string) {
  return new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: path } });
}

export async function GET(request: Request, context: { params: Promise<{ garageId: string; token: string }> }) {
  const { garageId: siteGarageId, token } = await context.params;
  const garage = await getHostGarage().catch(() => null);
  if (!garage || garage.id !== siteGarageId) return new NextResponse("Not found", { status: 404, headers: HEADERS });
  if (!(await consumeRateLimit(`${garage.id}:${requesterIp(request)}`, "pay_link", 30, 600))) return seeOther("/pay?link=limited");
  if (!isPayTokenShape(token)) return seeOther("/pay?link=invalid");
  const payment = await loadPaymentByToken(garage.id, token).catch(() => null);
  if (!payment) {
    const response = seeOther("/pay?link=invalid");
    response.cookies.set(PAY_COOKIE, "", payCookieOptions(0));
    return response;
  }
  const response = seeOther("/pay");
  response.cookies.set(PAY_COOKIE, token, payCookieOptions());
  return response;
}
