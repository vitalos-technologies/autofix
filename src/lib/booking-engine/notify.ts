import "server-only";

import { after } from "next/server";

/** A booking change the customer and the garage hear about. */
export type BookingNotice = {
  type: "created" | "rescheduled" | "cancelled";
  garageId: string;
  bookingId: string;
  /** Rescheduled only: the start before the move. */
  previousStartsAt?: string;
};

/**
 * Called by the engine after a booking is created, moved or cancelled (never
 * for an idempotent replay). The messages go out after the response with
 * `after()`, so a slow mail provider never delays the booking; outside a
 * request (scripts, tests) they are sent in the background. When the job
 * queue lands (P3.7) this enqueues `notifications.booking` instead.
 */
export function notifyBooking(notice: BookingNotice): void {
  const task = async () => {
    const { sendBookingNotifications } = await import("@/lib/bookings/notifications");
    await sendBookingNotifications(notice);
  };
  const run = () => task().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}
