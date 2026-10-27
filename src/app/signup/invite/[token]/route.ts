import { NextResponse, type NextRequest } from "next/server";
import { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE, isInviteToken } from "@/lib/signup/invite-token";
import { adminBaseUrl } from "@/lib/tenancy/urls";

/**
 * The invite email's link. Moves the token into an httpOnly cookie and answers 303 to
 * /signup/invite, so the token does not stay in the address bar, history or a Referer.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const response = NextResponse.redirect(new URL("/signup/invite", adminBaseUrl()), 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  if (isInviteToken(token)) {
    response.cookies.set(INVITE_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/signup/invite",
      maxAge: INVITE_COOKIE_MAX_AGE,
    });
  }
  return response;
}
