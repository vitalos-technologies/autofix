import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/** Short-lived manage-booking access, bound to one booking in one garage. */
type BookingAccessPayload = { bookingId: string; garageId: string; expiresAt: number };

function signingKey() {
  const key = process.env.BOOKING_MANAGEMENT_SECRET;
  if (key) return key;
  if (process.env.NODE_ENV !== "production") return "local-booking-management-only";
  throw new Error("Booking management signing is not configured");
}

function signature(encoded: string) {
  return createHmac("sha256", signingKey()).update(encoded).digest("base64url");
}

export function createBookingAccessToken(bookingId: string, garageId: string, ttlSeconds = 15 * 60) {
  const payload: BookingAccessPayload = { bookingId, garageId, expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

/** Valid only on the garage it was issued for: a token copied to another garage's host is rejected. */
export function verifyBookingAccessToken(token: string, garageId: string): BookingAccessPayload | null {
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) return null;
  const expected = signature(encoded);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as BookingAccessPayload;
    if (!payload.bookingId || !payload.garageId || payload.garageId !== garageId) return null;
    if (!Number.isInteger(payload.expiresAt) || payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
