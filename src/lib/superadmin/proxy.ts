/**
 * The Django super admin at `pitline.co.uk/superadmin` (DECISIONS D18, `superadmin/`).
 *
 * `src/proxy.ts` forwards `/superadmin/*` on the admin host to the super admin's own origin
 * (`SUPERADMIN_ORIGIN`, a container that answers only this proxy). On the way it:
 * - adds the shared secret (`SUPERADMIN_PROXY_SECRET`) the origin requires, or it answers 404;
 * - drops any `x-autofix-superadmin-*` header the browser sent, then sets the client IP and public host;
 * - forwards only the super admin's own cookies (`afsa_*`, `__Secure-afsa_*`), so Pitline's Supabase
 *   session never leaves for the super admin, whatever the browser sends.
 * Without a valid origin and secret, /superadmin is a 404.
 */
import type { NextRequest } from "next/server";

export const SUPERADMIN_PREFIX = "/superadmin";
export const PROXY_SECRET_HEADER = "x-autofix-superadmin-proxy";
export const CLIENT_IP_HEADER = "x-autofix-superadmin-client-ip";
export const PUBLIC_HOST_HEADER = "x-autofix-superadmin-host";
const OWN_HEADER_PREFIX = "x-autofix-superadmin-";
const COOKIE_NAME = /^(?:__Secure-)?afsa_[a-z_]+$/;
const IP = /^[0-9a-fA-F:.]{2,45}$/;
const MIN_SECRET_LENGTH = 32;

type Env = Partial<Record<"SUPERADMIN_ORIGIN" | "SUPERADMIN_PROXY_SECRET" | "NODE_ENV", string>>;

export function isSuperadminPath(pathname: string) {
  return pathname === SUPERADMIN_PREFIX || pathname.startsWith(`${SUPERADMIN_PREFIX}/`);
}

/** The origin to forward to: https (plain http only for localhost outside production), no path. */
export function superadminOrigin(env: Env = process.env): URL | null {
  const raw = env.SUPERADMIN_ORIGIN?.trim();
  if (!raw || (env.SUPERADMIN_PROXY_SECRET ?? "").length < MIN_SECRET_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && env.NODE_ENV !== "production")) return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  return url;
}

/** Only the super admin's cookies from a Cookie header; null when none are left. */
export function superadminCookies(cookieHeader: string | null) {
  const kept = (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => COOKIE_NAME.test(part.split("=", 1)[0] ?? ""));
  return kept.length ? kept.join("; ") : null;
}

/** The visitor's IP as Vercel's edge reports it (it overwrites both headers); null if malformed. */
export function clientIp(headers: Headers) {
  const candidate = headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0];
  const ip = candidate?.trim() ?? "";
  return IP.test(ip) ? ip : null;
}

/** Where to forward `request` and with which headers; null when the super admin is not configured. */
export function superadminRequest(request: NextRequest, env: Env = process.env) {
  const origin = superadminOrigin(env);
  if (!origin) return null;
  const url = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, origin);
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith(OWN_HEADER_PREFIX)) headers.delete(name);
  }
  const cookies = superadminCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  else headers.delete("cookie");
  headers.set(PROXY_SECRET_HEADER, env.SUPERADMIN_PROXY_SECRET as string);
  headers.set(PUBLIC_HOST_HEADER, request.headers.get("host") ?? request.nextUrl.host);
  const ip = clientIp(request.headers);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return { url, headers };
}
