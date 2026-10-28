import "server-only";

import { NextResponse } from "next/server";
import { featureGuard } from "@/lib/plans/server";
import { getAdminContext, type AdminContext } from "@/lib/tenancy/admin";
import { adminUrl } from "@/lib/tenancy/urls";
import { ACCOUNTING_SETTINGS_PATH } from "./server";
import { REAL_ACCOUNTING_PROVIDERS, type AccountingProviderId } from "./types";

// Guards shared by the OAuth route handlers (P5.10). The garage is always the signed-in owner's
// selected garage; nothing about the garage is read from the query or the body.

export const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export function settingsRedirect(query: Record<string, string>) {
  const url = new URL(adminUrl(ACCOUNTING_SETTINGS_PATH));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return NextResponse.redirect(url, { status: 303, headers: NO_STORE });
}

export function routeProvider(value: string): Exclude<AccountingProviderId, "fake"> | null {
  return (REAL_ACCOUNTING_PROVIDERS as readonly string[]).includes(value) ? (value as Exclude<AccountingProviderId, "fake">) : null;
}

/** A POST from another site (no Origin match) is refused: connect must be started from our page. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

/**
 * The owner of the selected garage, with MFA done in this session, on a plan with accounting sync.
 * Returns the context, or the response to send instead (login, MFA step-up, owner only, 403 PLAN_REQUIRED).
 */
export async function requireAccountingOwner(): Promise<{ admin: AdminContext } | { response: NextResponse }> {
  const admin = await getAdminContext();
  if (!admin) return { response: NextResponse.redirect(new URL(adminUrl("/app/login")), { status: 303, headers: NO_STORE }) };
  if (admin.impersonation) return { response: settingsRedirect({ error: "read_only" }) };
  if (admin.mfaState !== "verified" && admin.mfaState !== "unenrolled_allowed") {
    return { response: NextResponse.redirect(new URL(adminUrl(`/app/mfa?returnTo=${encodeURIComponent(ACCOUNTING_SETTINGS_PATH)}&stepUp=1`)), { status: 303, headers: NO_STORE }) };
  }
  const blocked = featureGuard(admin.garage, "accounting_sync");
  if (blocked) return { response: blocked };
  if (admin.role !== "owner") return { response: settingsRedirect({ error: "owner_only" }) };
  return { admin };
}
