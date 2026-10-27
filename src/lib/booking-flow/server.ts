import "server-only";

import { headers } from "next/headers";
import { getBookingEngine, type OnlineService } from "@/lib/booking-engine";
import type { BookingFlowMeta } from "@/lib/booking-engine/state";
import { visibleServices } from "@/lib/booking-flow/steps";
import { bookingCalendarDownloadUrl } from "@/lib/bookings/calendar";
import type { Garage } from "@/lib/tenancy/garage";
import { verifyTurnstile } from "@/lib/turnstile";

/**
 * The signed `.ics` link for a booking as a path on this host (booking pages are already on the
 * garage's host). The signature binds garage and reference; the link holds no customer details.
 */
export function bookingCalendarPath(garage: Garage, reference: string): string | null {
  const url = bookingCalendarDownloadUrl(garage, reference);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/** The garage's online services as the booking page shows them (MOT only when switched on). */
export async function loadBookingServices(garage: Pick<Garage, "id" | "motEnabled">): Promise<OnlineService[]> {
  return visibleServices(await getBookingEngine().listOnlineServices(garage.id), garage.motEnabled);
}

/** Client IP for rate limits (hashed by `consumeRateLimit`, never stored as is). */
export async function clientIp(): Promise<string> {
  const requestHeaders = await headers();
  return requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip")?.trim() || "unknown";
}

/** Turnstile is enforced only when both keys are configured. */
export function humanCheckConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY?.trim() && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim());
}

/** A Turnstile pass lasts as long as the draft it was made for (the draft cookie lives 2 hours). */
export function needsHumanCheck(meta: BookingFlowMeta): boolean {
  return humanCheckConfigured() && !meta.humanCheckedAt;
}

/**
 * Checks Turnstile once per draft. Returns the meta to store (with the pass recorded) or `null`
 * when the check failed.
 */
export async function passHumanCheck(token: FormDataEntryValue | null, meta: BookingFlowMeta, ip: string): Promise<BookingFlowMeta | null> {
  if (!needsHumanCheck(meta)) return meta;
  const value = typeof token === "string" ? token.trim() : "";
  if (!value || !(await verifyTurnstile(value, ip === "unknown" ? undefined : ip))) return null;
  return { ...meta, humanCheckedAt: Date.now() };
}
