import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isGarageAdminPath } from "@/config/admin";
import { requiresMfaChallenge } from "@/lib/auth/mfa";
import { isMandatoryAdminMfaEnabled } from "@/lib/auth/mfa-policy";
import { askbridgeScriptUrl } from "@/lib/askbridge/config";
import { ADMIN_SECURITY_HEADERS, bookingSiteHeaders } from "@/lib/booking-page/security-headers";
import { findValidTrustedDevice, isSensitiveAdminPath, TRUSTED_DEVICE_COOKIE } from "@/lib/auth/trusted-device";
import { classifyHost } from "@/lib/tenancy/hosts";
import { legacyHostDecision } from "@/lib/tenancy/legacy-hosts";
import { REQUEST_METHOD_HEADER, REQUEST_PATH_HEADER } from "@/lib/tenancy/request-headers";
import { resolveHost, type HostGarage } from "@/lib/tenancy/resolve";
import { isSuperadminPath, superadminRequest } from "@/lib/superadmin/proxy";

/** Internal prefix for garage booking sites (folder `src/app/%5Fsite/[garageId]`). */
export const SITE_PREFIX = "/_site";
/** Dev-only cookie that remembers `?__garage=<slug>` across navigations on localhost. */
export const DEV_GARAGE_COOKIE = "af_dev_garage";

/** Paths that only exist on the admin host. */
const ADMIN_ONLY_PREFIXES = ["/app", "/admin", "/auth", "/dev", "/signup", "/superadmin", "/api/admin", "/api/platform", "/api/cron", "/api/jobs", "/api/agent", "/api/voice"];

function hasPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function notFound() {
  return new NextResponse(
    "<!doctype html><html lang=\"en-GB\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>Page not found</title></head>"
      + "<body style=\"font-family:system-ui,sans-serif;margin:0;padding:40px 20px;color:#1e293b;background:#f8fafc\"><h1 style=\"margin:0 0 8px;color:#0f2747\">Page not found</h1>"
      + "<p style=\"margin:0;line-height:1.5\">There is no booking page at this address. Check the link you were given, or contact the garage.</p></body></html>",
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } },
  );
}

function requestHost(request: NextRequest) {
  return request.headers.get("host") ?? request.nextUrl.host;
}

/** The `?__garage=` value (or remembered cookie) on dev hosts; null elsewhere. */
function devGarageParam(request: NextRequest) {
  const host = classifyHost(requestHost(request));
  if (host.kind !== "admin" && host.kind !== "dev-garage") return null;
  const param = request.nextUrl.searchParams.get("__garage");
  if (param !== null) return param;
  // The remembered garage never hides the admin on localhost.
  const { pathname } = request.nextUrl;
  if (ADMIN_ONLY_PREFIXES.some((prefix) => hasPrefix(pathname, prefix))) return null;
  return request.cookies.get(DEV_GARAGE_COOKIE)?.value ?? null;
}

function routeGarageSite(request: NextRequest, garage: HostGarage) {
  const { pathname } = request.nextUrl;
  if (hasPrefix(pathname, SITE_PREFIX) || ADMIN_ONLY_PREFIXES.some((prefix) => hasPrefix(pathname, prefix))) return notFound();
  // Public API routes resolve the garage from the host themselves.
  if (hasPrefix(pathname, "/api")) return NextResponse.next();

  const target = request.nextUrl.clone();
  target.pathname = `${SITE_PREFIX}/${garage.id}${pathname === "/" ? "" : pathname}`;
  target.searchParams.delete("__garage");
  const response = NextResponse.rewrite(target);
  const param = request.nextUrl.searchParams.get("__garage");
  if (param) response.cookies.set(DEV_GARAGE_COOKIE, param, { httpOnly: true, sameSite: "lax", path: "/" });
  return response;
}

/** P5.3: the Supabase origin health check media is signed on (only matters when it isn't https, i.e. locally). */
function storageOrigin() {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Framing and CSP per host: a garage's booking pages may be framed by the sites it allowed (and load
 * the Askbridge widget when it is on); everything else is same-origin only. `next.config.ts` sets the
 * headers that are the same on every host.
 */
function withSecurityHeaders(response: NextResponse, garage: HostGarage | null) {
  const headers = garage
    ? bookingSiteHeaders({
      embedOrigins: garage.embedOrigins ?? [],
      widgetOrigin: garage.widgetEnabled ? (askbridgeScriptUrl()?.origin ?? null) : null,
      dev: process.env.NODE_ENV === "development",
      storageOrigin: storageOrigin(),
    })
    : ADMIN_SECURITY_HEADERS;
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  if (garage) response.headers.delete("X-Frame-Options");
  return response;
}

/** Next.js's own trailing-slash redirect (off in next.config.ts), except under /superadmin. */
function trailingSlashRedirect(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/" || !pathname.endsWith("/") || isSuperadminPath(pathname)) return null;
  // A plain URL: NextURL would put the slash back when formatting.
  const url = new URL(request.url);
  url.pathname = pathname.replace(/\/+$/, "") || "/";
  return NextResponse.redirect(url, 308);
}

export async function proxy(request: NextRequest) {
  const host = requestHost(request);
  // The old Autofix addresses first, so one redirect lands on the final URL (DECISIONS D22).
  const legacy = legacyHostDecision(request.url, host);
  if (legacy?.kind === "redirect") return NextResponse.redirect(legacy.location, 308);
  if (legacy?.kind === "serve") return withSecurityHeaders(await adminHost(request, null), null);
  const slashRedirect = trailingSlashRedirect(request);
  if (slashRedirect) return slashRedirect;
  const param = devGarageParam(request);
  let resolution;
  try {
    resolution = await resolveHost(host, { devGarageParam: param });
  } catch {
    return withSecurityHeaders(new NextResponse("Service temporarily unavailable", { status: 503, headers: { "retry-after": "30" } }), null);
  }

  if (resolution.kind === "garage") return withSecurityHeaders(routeGarageSite(request, resolution.garage), resolution.garage);
  // The Django super admin sets its own, stricter headers (CSP, framing), so they are left alone.
  if (resolution.kind === "admin" && isSuperadminPath(request.nextUrl.pathname)) return superadmin(request);
  return withSecurityHeaders(resolution.kind === "unknown" ? notFound() : await adminHost(request, param), null);
}

/** Forwards /superadmin/* to the super admin's origin (src/lib/superadmin/proxy.ts); 404 when not set up. */
function superadmin(request: NextRequest) {
  const target = superadminRequest(request);
  if (!target) return notFound();
  return NextResponse.rewrite(target.url, { request: { headers: target.headers } });
}

async function adminHost(request: NextRequest, param: string | null) {
  const { pathname } = request.nextUrl;

  // Admin host from here on.
  if (hasPrefix(pathname, SITE_PREFIX)) return notFound();
  // Server code reads the method and path from these (impersonation is read-only, P4.5); always ours, never the client's.
  request.headers.set(REQUEST_METHOD_HEADER, request.method);
  request.headers.set(REQUEST_PATH_HEADER, pathname);
  if (param === "" && request.cookies.has(DEV_GARAGE_COOKIE)) {
    const response = NextResponse.next({ request });
    response.cookies.delete(DEV_GARAGE_COOKIE);
    return response;
  }
  if (isGarageAdminPath(pathname) || hasPrefix(pathname, "/auth") || hasPrefix(pathname, "/admin") || hasPrefix(pathname, "/api/platform") || hasPrefix(pathname, "/signup")) {
    return adminSession(request);
  }
  return NextResponse.next({ request });
}

/** Refreshes the Supabase session and enforces SOB's MFA rules on `/app`. */
async function adminSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookieOptions: { sameSite: "lax", secure: process.env.NODE_ENV === "production" },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  const pathname = request.nextUrl.pathname;
  const challengeAllowed = pathname === "/app/mfa" || pathname.startsWith("/app/mfa/");
  const publicAdminRoute = pathname === "/app/login" || pathname.startsWith("/app/forgot-password") || pathname.startsWith("/app/reset-password");
  if (user && isGarageAdminPath(pathname) && !challengeAllowed && !publicAdminRoute) {
    const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const trustedClient = secretKey ? createSupabaseClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
    if (assurance && requiresMfaChallenge(assurance)) {
      const trustedDevice = !isSensitiveAdminPath(pathname) && trustedClient
        ? await findValidTrustedDevice(trustedClient, user.id, request.cookies.get(TRUSTED_DEVICE_COOKIE)?.value)
        : null;
      if (trustedDevice) return response;
      const challengeUrl = request.nextUrl.clone();
      challengeUrl.pathname = "/app/mfa";
      const returnTo = `${pathname}${request.nextUrl.search}`;
      challengeUrl.search = "";
      challengeUrl.searchParams.set("returnTo", returnTo);
      const redirectResponse = NextResponse.redirect(challengeUrl);
      response.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie));
      return redirectResponse;
    }
    // Onboarding (P4.4) runs its own, stricter rule: every step after Security needs MFA verified, and
    // the Security step sends the owner to /app/mfa/enroll and back.
    if (assurance?.currentLevel === "aal1" && assurance.nextLevel === "aal1" && !hasPrefix(pathname, "/app/onboarding") && await isMandatoryAdminMfaEnabled(trustedClient)) {
      const enrollmentUrl = request.nextUrl.clone();
      enrollmentUrl.pathname = "/app/mfa/enroll";
      enrollmentUrl.search = "";
      const redirectResponse = NextResponse.redirect(enrollmentUrl);
      response.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie));
      return redirectResponse;
    }
  }
  return response;
}

export const config = {
  // Every route except build assets and static files, so no garage host can reach an unrouted page.
  // /superadmin is listed on its own so its static files (icons, fonts) are forwarded too.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?|map)$).*)", "/superadmin/:path*"],
};
