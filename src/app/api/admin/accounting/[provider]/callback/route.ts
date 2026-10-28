import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ACCOUNTING_OAUTH_COOKIE, accountingOAuthCookieOptions, checkCallback, openOAuthState } from "@/lib/accounting/oauth";
import { getAccountingProvider } from "@/lib/accounting/providers";
import { NO_STORE, requireAccountingOwner, routeProvider, settingsRedirect } from "@/lib/accounting/routes";
import { accountingCallbackUrl, saveConnection } from "@/lib/accounting/server";
import { isAccountingError } from "@/lib/accounting/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clearCookie(response: NextResponse) {
  response.cookies.set(ACCOUNTING_OAUTH_COOKIE, "", { ...accountingOAuthCookieOptions(), maxAge: 0 });
  return response;
}

/**
 * GET /api/admin/accounting/[provider]/callback (P5.10): the provider sends the owner back here. The
 * state must match the sealed cookie, which must have been made for this provider, this garage (the
 * session's selected garage) and this user. The code is exchanged with the PKCE verifier, the
 * tokens are encrypted and stored, and the owner goes back to the settings page (to choose the
 * organisation when there are several). Never logs the code, the tokens or the provider's text.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const providerId = routeProvider((await params).provider);
  if (!providerId) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers: NO_STORE });
  const guard = await requireAccountingOwner();
  if ("response" in guard) return clearCookie(guard.response);
  const { admin } = guard;

  const query = request.nextUrl.searchParams;
  const cookie = openOAuthState(request.cookies.get(ACCOUNTING_OAUTH_COOKIE)?.value);
  const problem = checkCallback(cookie, { state: query.get("state"), provider: providerId, garageId: admin.garage.id, userId: admin.user.id });
  if (problem) return clearCookie(settingsRedirect({ error: problem === "expired" ? "connect_expired" : "connect_state" }));
  if (query.get("error")) return clearCookie(settingsRedirect({ error: "connect_denied" }));
  const code = query.get("code");
  if (!code || code.length > 4096) return clearCookie(settingsRedirect({ error: "connect_failed" }));

  try {
    const provider = getAccountingProvider(providerId);
    const tokens = await provider.exchangeCode({ code, codeVerifier: cookie!.verifier, redirectUri: accountingCallbackUrl(providerId), callbackParams: query });
    const tenants = await provider.listTenants(tokens);
    if (tenants.length === 0) return clearCookie(settingsRedirect({ error: "no_organisation" }));
    const saved = await saveConnection({ garageId: admin.garage.id, provider: providerId, tokens, tenants, userId: admin.user.id });
    return clearCookie(settingsRedirect(saved.status === "pending" ? { choose: "1" } : { done: "connected" }));
  } catch (error) {
    console.error("[accounting] connect failed", isAccountingError(error) ? error.code : "unexpected");
    return clearCookie(settingsRedirect({ error: "connect_failed" }));
  }
}
