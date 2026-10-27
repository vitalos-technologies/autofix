import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isGarageAdminPath } from "@/config/admin";
import { requiresMfaChallenge } from "@/lib/auth/mfa";
import { isMandatoryAdminMfaEnabled } from "@/lib/auth/mfa-policy";
import { findValidTrustedDevice, isSensitiveAdminPath, TRUSTED_DEVICE_COOKIE } from "@/lib/auth/trusted-device";
import { classifyHost } from "@/lib/tenancy/hosts";
import { resolveHost, type HostGarage } from "@/lib/tenancy/resolve";

/** Internal prefix for garage booking sites (folder `src/app/%5Fsite/[garageId]`). */
export const SITE_PREFIX = "/_site";
/** Dev-only cookie that remembers `?__garage=<slug>` across navigations on localhost. */
export const DEV_GARAGE_COOKIE = "af_dev_garage";

/** Paths that only exist on the admin host. */
const ADMIN_ONLY_PREFIXES = ["/app", "/admin", "/auth", "/dev", "/signup", "/api/admin", "/api/platform", "/api/cron", "/api/jobs", "/api/agent"];

function hasPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function notFound() {
  return new NextResponse(
    "<!doctype html><html lang=\"en-GB\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>Page not found</title></head>"
      + "<body style=\"font-family:system-ui,sans-serif;margin:0;padding:40px 20px;color:#202a36;background:#f4f7fa\"><h1 style=\"margin:0 0 8px;color:#071127\">Page not found</h1>"
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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = requestHost(request);
  const param = devGarageParam(request);
  let resolution;
  try {
    resolution = await resolveHost(host, { devGarageParam: param });
  } catch {
    return new NextResponse("Service temporarily unavailable", { status: 503, headers: { "retry-after": "30" } });
  }

  if (resolution.kind === "unknown") return notFound();
  if (resolution.kind === "garage") return routeGarageSite(request, resolution.garage);

  // Admin host from here on.
  if (hasPrefix(pathname, SITE_PREFIX)) return notFound();
  if (param === "" && request.cookies.has(DEV_GARAGE_COOKIE)) {
    const response = NextResponse.next();
    response.cookies.delete(DEV_GARAGE_COOKIE);
    return response;
  }
  if (isGarageAdminPath(pathname) || hasPrefix(pathname, "/auth") || hasPrefix(pathname, "/signup")) return adminSession(request);
  return NextResponse.next();
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
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?|map)$).*)"],
};
