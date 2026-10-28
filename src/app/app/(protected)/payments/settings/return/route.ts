import { NextResponse } from "next/server";
import { refreshConnectedAccount } from "@/lib/payments/server";
import { getAdminContext } from "@/lib/tenancy/admin";

// P5.4: where Stripe's account onboarding sends the owner back (and its "link expired" refresh). Reads
// the connected account's state from Stripe and stores it, then shows Payment settings. The garage is
// the member's selected garage; only its own stored account is refreshed.

const SETTINGS = "/app/payments/settings";

export async function GET(request: Request) {
  const admin = await getAdminContext();
  if (!admin) return NextResponse.redirect(new URL("/app/login", request.url), 303);
  const query = admin.role !== "owner" ? "?error=owner_only" : await refreshConnectedAccount(admin.garage, admin.user.id);
  return NextResponse.redirect(new URL(`${SETTINGS}${query}`, request.url), 303);
}
