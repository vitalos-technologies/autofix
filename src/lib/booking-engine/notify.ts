import "server-only";

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
 * for an idempotent replay). Notifications are wired in by P2.10.
 */
export function notifyBooking(notice: BookingNotice): void {
  void notice;
}
