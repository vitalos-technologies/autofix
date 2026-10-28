import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HEALTH_CHECK_LINK_TTL_DAYS } from "./checklist";

// Health check links (P5.3). The customer gets `/hc/<token>` on the garage's booking host: 16 random
// bytes, base64url (22 characters, as reminder links, so a text stays one segment where it can).
// Only the SHA-256 hex is stored (health_checks.token_hash) with a 14-day expiry; the token is in
// the message the customer received and nowhere else (never logged, never stored, and the
// outbound messages row records the body with the link shortened to `/hc/…`).
//
// The link handler swaps the token for a signed httpOnly session cookie (`af_hc`, path
// /health-check, 60 minutes: garage id + check id) and 303s to the clean `/health-check` page, so
// the token never stays in the address bar, history or a Referer. Signed with
// BOOKING_MANAGEMENT_SECRET under its own context (no new secret to configure).

export const HEALTH_CHECK_TOKEN_BYTES = 16;
export const HEALTH_CHECK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const HEALTH_CHECK_COOKIE = "af_hc";
export const HEALTH_CHECK_COOKIE_PATH = "/health-check";
export const HEALTH_CHECK_SESSION_SECONDS = 60 * 60;

const DEV_SECRET = "local-booking-management-only";
const SESSION_CONTEXT = "health-check-session:v1";

export type HealthCheckToken = { token: string; hash: string; expiresAt: Date };

export function hashHealthCheckToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createHealthCheckToken(now: Date = new Date()): HealthCheckToken {
  const token = randomBytes(HEALTH_CHECK_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashHealthCheckToken(token), expiresAt: new Date(now.getTime() + HEALTH_CHECK_LINK_TTL_DAYS * 24 * 60 * 60 * 1000) };
}

export function isHealthCheckToken(value: unknown): value is string {
  return typeof value === "string" && HEALTH_CHECK_TOKEN_PATTERN.test(value);
}

/** The path on the garage's booking host. */
export function healthCheckLinkPath(token: string): string {
  return `/hc/${token}`;
}

/** What the outbound message row stores instead of the real link. */
export function redactHealthCheckLink(body: string, token: string): string {
  return body.split(healthCheckLinkPath(token)).join("/hc/…");
}

function sessionSecret(): string {
  const key = process.env.BOOKING_MANAGEMENT_SECRET?.trim();
  if (key) return key;
  if (process.env.NODE_ENV !== "production") return DEV_SECRET;
  throw new Error("Health check link signing is not configured");
}

function signature(encoded: string): string {
  return createHmac("sha256", sessionSecret()).update(`${SESSION_CONTEXT}:${encoded}`).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Signed `af_hc` value: `{garage, check, expiry}`. */
export function createHealthCheckSession(garageId: string, checkId: string, now = Date.now()): string {
  const payload = { g: garageId, c: checkId, e: Math.floor(now / 1000) + HEALTH_CHECK_SESSION_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

/** The check a session opens, only on the garage it was issued for and before it expires. */
export function readHealthCheckSession(value: string | null | undefined, garageId: string, now = Date.now()): { checkId: string } | null {
  if (!value || value.length > 1_000) return null;
  const [encoded, signed, extra] = value.split(".");
  if (!encoded || !signed || extra !== undefined) return null;
  let expected: string;
  try {
    expected = signature(encoded);
  } catch {
    return null;
  }
  if (!safeEqual(signed, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { g?: unknown; c?: unknown; e?: unknown };
    if (payload.g !== garageId || typeof payload.c !== "string" || typeof payload.e !== "number") return null;
    if (!Number.isInteger(payload.e) || payload.e <= Math.floor(now / 1000)) return null;
    return { checkId: payload.c };
  } catch {
    return null;
  }
}

export function healthCheckCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: HEALTH_CHECK_COOKIE_PATH,
    maxAge: HEALTH_CHECK_SESSION_SECONDS,
  };
}
