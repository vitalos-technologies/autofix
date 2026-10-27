import "server-only";

import { createHash } from "node:crypto";
import { after } from "next/server";

/** A booking change the customer and the garage hear about. */
export type BookingNotice = {
  /** `confirmed`: staff accepted a requested booking (A88). */
  type: "created" | "confirmed" | "rescheduled" | "cancelled";
  garageId: string;
  bookingId: string;
  /** Rescheduled only: the start before the move. */
  previousStartsAt?: string;
};

/** How long the after-response drain may take (Vercel keeps the function alive for it). */
const AFTER_RESPONSE_BUDGET_MS = 15_000;

/**
 * One job per booking event. A move is keyed by the start it moved from, so moving the same booking
 * again later is a new job while a retried call for the same move is not.
 */
export function bookingNoticeDedupeKey(notice: BookingNotice) {
  const version = notice.type === "rescheduled"
    ? createHash("sha256").update(notice.previousStartsAt ?? "unknown").digest("hex").slice(0, 16)
    : "once";
  return `notifications.booking:${notice.garageId}:${notice.bookingId}:${notice.type}:${version}`;
}

function afterResponse(task: () => Promise<unknown>) {
  const run = () => task().catch(() => undefined);
  try {
    after(run);
  } catch {
    // Outside a request (scripts, tests): run in the background.
    void run();
  }
}

/**
 * Called by the engine after a booking is created, moved or cancelled (never for an idempotent
 * replay). The notice is queued as a `notifications.booking` job (P3.7), so it survives a crash or a
 * slow provider, and that job is run straight after the response with `after()`. Anything left over
 * is picked up by the next drain (cron or `POST /api/jobs/drain`). If the queue cannot be reached,
 * the messages are sent directly after the response instead, as before P3.7. Never throws.
 */
export async function notifyBooking(notice: BookingNotice): Promise<void> {
  let queued = false;
  try {
    const { enqueueJob } = await import("@/lib/jobs/queue");
    await enqueueJob("notifications.booking", { ...notice }, { garageId: notice.garageId, dedupeKey: bookingNoticeDedupeKey(notice) });
    queued = true;
  } catch {
    queued = false;
  }

  afterResponse(async () => {
    if (queued) {
      const { drainJobs } = await import("@/lib/jobs/runner");
      await drainJobs({ kinds: ["notifications.booking"], budgetMs: AFTER_RESPONSE_BUDGET_MS });
      return;
    }
    const { sendBookingNotifications } = await import("@/lib/bookings/notifications");
    await sendBookingNotifications(notice);
  });
}
