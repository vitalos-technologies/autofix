import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { garageUrl, type GarageUrlSubject, type UrlEnvironment } from "@/lib/tenancy/urls";

// Signed unsubscribe links (P4.9, DECISIONS A13).
//
// `/unsubscribe/<token>` on the garage's own host. The token is the customer
// id (16 bytes) and a 128-bit HMAC-SHA-256 tag over the garage id and the
// customer id, both base64url: `<22 chars>.<22 chars>`. It holds no phone
// number, email or registration, and the garage is never in it: the page
// verifies the tag against the host's garage, so a link only works on the
// garage it was issued for. Links do not expire (an opt-out must keep
// working); rotating the secret retires every link.
//
// Key: BOOKING_MANAGEMENT_SECRET (already required in production for manage
// links), separated from manage links by its own context label.

const DEV_SECRET = "local-booking-management-only";
const CONTEXT = "customer-unsubscribe:v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;

export type UnsubscribeEnv = { BOOKING_MANAGEMENT_SECRET?: string; NODE_ENV?: string };

function signingSecret(env: UnsubscribeEnv): string | null {
  const key = env.BOOKING_MANAGEMENT_SECRET?.trim();
  if (key) return key;
  return env.NODE_ENV === "production" ? null : DEV_SECRET;
}

function uuidToBytes(uuid: string) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Buffer) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function tag(secret: string, garageId: string, customerId: string) {
  return createHmac("sha256", secret).update(`${CONTEXT}:${garageId.toLowerCase()}:${customerId.toLowerCase()}`).digest().subarray(0, 16);
}

/** The token for one customer of one garage, or null when signing is not configured (production without the secret). */
export function createUnsubscribeToken(garageId: string, customerId: string, env: UnsubscribeEnv = process.env): string | null {
  const secret = signingSecret(env);
  if (!secret || !UUID_PATTERN.test(garageId) || !UUID_PATTERN.test(customerId)) return null;
  return `${uuidToBytes(customerId).toString("base64url")}.${tag(secret, garageId, customerId).toString("base64url")}`;
}

/** The customer id a token names, if it was issued for this garage; null otherwise. Constant-time tag check. */
export function verifyUnsubscribeToken(garageId: string, token: string | null | undefined, env: UnsubscribeEnv = process.env): string | null {
  const secret = signingSecret(env);
  if (!secret || !token || !TOKEN_PATTERN.test(token) || !UUID_PATTERN.test(garageId)) return null;
  const [idPart = "", tagPart = ""] = token.split(".");
  const idBytes = Buffer.from(idPart, "base64url");
  const given = Buffer.from(tagPart, "base64url");
  if (idBytes.length !== 16 || given.length !== 16) return null;
  // 16 bytes leave 4 unused bits in the last character, so four spellings decode to the same
  // bytes: accept only the one we issue, so a changed character never still works.
  if (idBytes.toString("base64url") !== idPart || given.toString("base64url") !== tagPart) return null;
  const customerId = bytesToUuid(idBytes);
  return timingSafeEqual(given, tag(secret, garageId, customerId)) ? customerId : null;
}

/** The absolute unsubscribe link for message templates (`{unsubscribe_link}`), or null when signing is not configured. */
export function unsubscribeUrl(
  garage: GarageUrlSubject & { id: string },
  customerId: string,
  env: UnsubscribeEnv & UrlEnvironment = process.env,
): string | null {
  const token = createUnsubscribeToken(garage.id, customerId, env);
  return token ? garageUrl(garage, `/unsubscribe/${token}`, env) : null;
}
