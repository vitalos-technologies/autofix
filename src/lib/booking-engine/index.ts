import "server-only";

import { createSupabaseBookingEngine } from "@/lib/booking-engine/repository";
import type { BookingEngine } from "@/lib/booking-engine/types";

export * from "@/lib/booking-engine/types";

let engine: BookingEngine | null = null;

/** The booking engine used by the booking pages, the `/api/*` booking routes and the agent tool API. */
export function getBookingEngine(): BookingEngine {
  engine ??= createSupabaseBookingEngine();
  return engine;
}

/** Tests inject a fake engine; `null` restores the real one. */
export function setBookingEngineForTests(next: BookingEngine | null) {
  engine = next;
}
