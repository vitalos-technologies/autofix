/**
 * Super admin (P4.5) rules with no I/O, shared by the /admin pages, the
 * /api/platform routes and getAdminContext(), and unit tested.
 */
import { REQUEST_METHOD_HEADER } from "@/lib/tenancy/request-headers";

export const GARAGE_PLANS = ["trial", "growth", "front_desk"] as const;
export const GARAGE_STATUSES = ["onboarding", "active", "suspended", "cancelled"] as const;
export type GaragePlan = (typeof GARAGE_PLANS)[number];
export type GarageStatus = (typeof GARAGE_STATUSES)[number];

export const PLAN_LABELS: Record<GaragePlan, string> = { trial: "Trial", growth: "Growth", front_desk: "Front desk" };
export const STATUS_LABELS: Record<GarageStatus, string> = {
  onboarding: "Onboarding",
  active: "Active",
  suspended: "Suspended",
  cancelled: "Cancelled",
};

/** Impersonation sessions: 30 minutes by default, 5 to 60 allowed (the database enforces the same). */
export const IMPERSONATION_MINUTES = 30;
export const IMPERSONATION_MIN_MINUTES = 5;
export const IMPERSONATION_MAX_MINUTES = 60;
/** httpOnly hint cookie: only tells getAdminContext() to look for a session. The database decides. */
export const IMPERSONATION_COOKIE = "af_impersonation";
export const IMPERSONATION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: IMPERSONATION_MAX_MINUTES * 60,
};

export const REASON_MIN = 5;
export const REASON_MAX = 500;
export const GARAGES_PAGE_SIZE = 25;

export function isGaragePlan(value: unknown): value is GaragePlan {
  return typeof value === "string" && (GARAGE_PLANS as readonly string[]).includes(value);
}

export function isGarageStatus(value: unknown): value is GarageStatus {
  return typeof value === "string" && (GARAGE_STATUSES as readonly string[]).includes(value);
}

/** Collapses whitespace; null unless 5 to 500 characters remain. */
export function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length >= REASON_MIN && cleaned.length <= REASON_MAX ? cleaned : null;
}

export type PlatformAccessInput = {
  signedIn: boolean;
  isPlatformAdmin: boolean;
  /** Supabase assurance: currentLevel/nextLevel. */
  currentLevel: string | null | undefined;
  nextLevel: string | null | undefined;
};

/**
 * Who may use /admin: signed-in platform admins whose session passed MFA (AAL2).
 * Everyone else gets a 404 ("not_found"), so the area is never revealed.
 * A platform admin still owing MFA is sent to the challenge, or to enrolment
 * when they have no verified factor. Trusted devices never count here.
 */
export function platformAccess(input: PlatformAccessInput): "allowed" | "challenge" | "enroll" | "not_found" {
  if (!input.signedIn || !input.isPlatformAdmin) return "not_found";
  if (input.currentLevel === "aal2") return "allowed";
  return input.nextLevel === "aal2" ? "challenge" : "enroll";
}

type HeaderReader = Pick<Headers, "get" | "has">;

/**
 * True only for plain page or route reads: the proxy-set method is GET or HEAD
 * and the request is not a server action. Anything else (including a missing
 * method header) counts as a write, so impersonation fails closed.
 */
export function isReadRequest(requestHeaders: HeaderReader) {
  if (requestHeaders.has("next-action")) return false;
  const method = requestHeaders.get(REQUEST_METHOD_HEADER)?.toUpperCase();
  return method === "GET" || method === "HEAD";
}

/** Router prefetches are not page views. */
export function isPrefetch(requestHeaders: HeaderReader) {
  return requestHeaders.has("next-router-prefetch") || requestHeaders.get("purpose") === "prefetch" || requestHeaders.get("sec-purpose")?.includes("prefetch") === true;
}

export type ImpersonationRow = {
  id: string;
  garage_id: string;
  garage_name: string;
  reason: string;
  started_at: string;
  expires_at: string;
};

export type Impersonation = {
  id: string;
  garageId: string;
  garageName: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
};

/** The session from current_impersonation(), or null when there is none or it has expired by `now`. */
export function toImpersonation(row: ImpersonationRow | null | undefined, now = Date.now()): Impersonation | null {
  if (!row?.id || !row.garage_id) return null;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return {
    id: row.id,
    garageId: String(row.garage_id).toLowerCase(),
    garageName: row.garage_name,
    reason: row.reason,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
  };
}

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
const PHONE = /(?:\+|\b0)(?:[\s().-]?\d){9,14}\b/g;
// Current, prefix and suffix UK formats, any case, spaces optional.
const REGISTRATION = /\b(?:[A-Z]{2}\d{2}\s?[A-Z]{3}|[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z])\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * A job's last_error for the health page: emails, phone numbers and anything
 * shaped like a UK registration are masked (registration privacy), ids kept,
 * at most 300 characters. Payloads are never shown.
 */
export function redactJobError(value: string | null | undefined) {
  if (!value) return "";
  const ids: string[] = [];
  const masked = value
    .replace(UUID, (id) => `\u0000${ids.push(id) - 1}\u0000`)
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .replace(REGISTRATION, "[reg]")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => ids[Number(index)] ?? "");
  return masked.length > 300 ? `${masked.slice(0, 299)}…` : masked;
}
