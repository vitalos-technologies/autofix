import "server-only";

import type { BookingNotice } from "@/lib/booking-engine/notify";
import type { DeliveryOutcome, SendBookingNotificationsOptions } from "@/lib/bookings/notifications";
import { notificationsBookingPayload, parsePayload } from "../payloads";
import type { JobHandler } from "../types";

// `notifications.booking`: the customer email (+ .ics), staff alert and text
// for one booking event (P2.10). Queued by notifyBooking() on create,
// reschedule and cancel, and run straight after the response. Each message is
// reserved in booking_notification_events before it is sent, so a repeated
// job never sends twice; a failed message is recorded, not retried.

export type NotificationsBookingDeps = {
  send?: (notice: BookingNotice, options: SendBookingNotificationsOptions) => Promise<DeliveryOutcome[]>;
};

export function createNotificationsBookingHandler(deps: NotificationsBookingDeps = {}): JobHandler {
  return async (payload, context) => {
    const notice = parsePayload(notificationsBookingPayload, payload, context.job);
    const send = deps.send ?? (await import("@/lib/bookings/notifications")).sendBookingNotifications;
    const outcomes = await send(notice, { client: context.db, now: context.now(), env: context.env });
    const counts: Record<string, number> = { sent: 0, failed: 0, duplicate: 0, skipped: 0 };
    for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    return { outcome: outcomes.length === 0 ? "nothing_to_send" : "delivered", counts };
  };
}

export const notificationsBookingHandler = createNotificationsBookingHandler();
