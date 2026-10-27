import "server-only";

import { createFakeBookingEngine } from "@/lib/booking-engine/fake";
import { createSupabaseBookingEngine } from "@/lib/booking-engine/repository";
import type { BookingEngine } from "@/lib/booking-engine/types";

export * from "@/lib/booking-engine/types";

let engine: BookingEngine | null = null;

/**
 * `BOOKING_ENGINE=fake` swaps in the deterministic in-memory engine (`fake.ts`) for UI work without
 * the scheduling tables. Ignored in production builds (they always use the database), except a local
 * Playwright run of the production build (`PLAYWRIGHT_TEST=true`), and never on Vercel production.
 */
export function fakeEngineRequested(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (env.BOOKING_ENGINE !== "fake" || env.VERCEL_ENV === "production") return false;
  return env.NODE_ENV !== "production" || env.PLAYWRIGHT_TEST === "true";
}

/** The booking engine used by the booking pages, the `/api/*` booking routes and the agent tool API. */
export function getBookingEngine(): BookingEngine {
  engine ??= fakeEngineRequested() ? createFakeBookingEngine({ shared: true }) : createSupabaseBookingEngine();
  return engine;
}

/** Tests inject a fake engine; `null` restores the real one. */
export function setBookingEngineForTests(next: BookingEngine | null) {
  engine = next;
}
