import "server-only";

import type { BookingEngine } from "@/lib/booking-engine/types";

/**
 * Supabase-backed engine over `available_slots()` / `create_booking()` (docs/autofix/ARCHITECTURE.md).
 * Placeholder until P2.5 lands the implementation.
 */
export function createSupabaseBookingEngine(): BookingEngine {
  const unavailable = async (): Promise<never> => {
    throw new Error("Booking engine not implemented yet (P2.5)");
  };
  return { listOnlineServices: unavailable, getAvailableSlots: unavailable, createBooking: unavailable };
}
