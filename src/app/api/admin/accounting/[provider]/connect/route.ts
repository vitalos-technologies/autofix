import { NextResponse } from "next/server";
import { recordAdminAudit } from "@/lib/admin/audit";
import { hasAccountingKey } from "@/lib/accounting/crypto";
import { ACCOUNTING_OAUTH_COOKIE, accountingOAuthCookieOptions, createOAuthState, pkceChallenge, sealOAuthState } from "@/lib/accounting/oauth";
import { getAccountingProvider } from "@/lib/accounting/providers";
import { NO_STORE, isSameOrigin, requireAccountingOwner, routeProvider, settingsRedirect } from "@/lib/accounting/routes";
import { accountingCallbackUrl } from "@/lib/accounting/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/accounting/[provider]/connect (P5.10): the owner starts OAuth with Xero, QuickBooks
 * or Sage. Sets the sealed state cookie (state + PKCE verifier + garage + user, httpOnly, SameSite=Lax,
 * 10 minutes) and sends the browser to the provider's consent page. 403 PLAN_REQUIRED on Essentials.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const providerId = routeProvider((await params).provider);
  if (!providerId) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers: NO_STORE });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "BAD_ORIGIN" }, { status: 403, headers: NO_STORE });
  const guard = await requireAccountingOwner();
  if ("response" in guard) return guard.response;
  const { admin } = guard;

  const provider = getAccountingProvider(providerId);
  if (!provider.configured || !hasAccountingKey()) return settingsRedirect({ error: "configuration_required", provider: providerId });

  const state = createOAuthState({ provider: providerId, garageId: admin.garage.id, userId: admin.user.id });
  let authorizeUrl: string;
  try {
    authorizeUrl = provider.authorizeUrl({ state: state.state, codeChallenge: pkceChallenge(state.verifier), redirectUri: accountingCallbackUrl(providerId) });
  } catch {
    return settingsRedirect({ error: "configuration_required", provider: providerId });
  }
  try {
    await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "accounting.connect_started", entityType: "accounting_connection", entityId: providerId, detail: { provider: providerId } });
  } catch {
    // The audit log is a record, not a gate.
  }
  const response = NextResponse.redirect(authorizeUrl, { status: 303, headers: NO_STORE });
  response.cookies.set(ACCOUNTING_OAUTH_COOKIE, sealOAuthState(state), accountingOAuthCookieOptions());
  return response;
}

export function GET() {
  return NextResponse.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}
