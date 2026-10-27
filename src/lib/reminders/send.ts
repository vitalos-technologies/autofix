import "server-only";

import type { ChannelKind, MessageChannel, SendFailure, SendResult } from "@/lib/messaging/channel";
import { isWithinSendWindow, nextSendWindow } from "@/lib/messaging/quiet-hours";
import { garageUrl, type GarageUrlSubject, type UrlEnvironment } from "@/lib/tenancy/urls";
import { composeReminder, type ClaimedReminder } from "./compose";
import { createReminderLinkToken, reminderLinkPath, type ReminderLinkToken } from "./link-token";

// Sending a garage's due reminders (SPEC "Reminders pipeline" steps 2-4).
//
// Only inside the send window (09:00-19:00 Mon-Sat, garage time zone). Rows
// are claimed by claim_reminder_sends(), which re-checks consent, opt-out,
// rule and due date in SQL and marks them `sending` before anything is sent
// (DECISIONS A14: Twilio has no idempotency key). Then, per row: a fresh
// link token (only its hash is stored), the rendered template (refused when a
// placeholder has no value), a `messages` row in `sending`, the send, and the
// result on both rows. An ambiguous result (timeout, reset) is recorded as
// failed and never retried automatically. A definite non-send that may work
// later (rate limit, provider 5xx, missing configuration) puts the row back to
// `scheduled` and stops the batch.

export const REMINDER_SEND_BATCH = 10;

export type ReminderSendGarage = GarageUrlSubject & { id: string; name: string; timezone: string; status: string };

export type PreparedReminder = { linkHash: string; linkExpiresAt: Date; body: string; to: string; provider: string };

/** Storage for the send loop. `createSupabaseReminderSendRepo` is the real one; tests pass fakes. */
export interface ReminderSendRepo {
  claim(garageId: string, now: Date, limit: number): Promise<ClaimedReminder[]>;
  /** Stores the link hash, expiry and body on the send and inserts the outbound `messages` row (`sending`). */
  prepare(garageId: string, reminder: ClaimedReminder, prepared: PreparedReminder): Promise<{ messageId: string }>;
  markSent(garageId: string, reminderId: string, messageId: string, result: { providerMessageId: string; status: string }, sentAt: Date): Promise<void>;
  markFailed(garageId: string, reminderId: string, messageId: string | null, errorCode: string): Promise<void>;
  /** Back to `scheduled` (nothing was sent); their messages rows are removed. */
  release(garageId: string, reminderIds: string[], messageIds: string[]): Promise<void>;
  /** The provider says this number unsubscribed (Twilio 21610): mirror it as a STOP. */
  optOut(garageId: string, phone: string): Promise<void>;
}

export type SendWindow = { open: true } | { open: false; next: Date };

/** Whether reminders may go out now in the garage's time zone, else when the window next opens. */
export function sendWindow(now: Date, timeZone: string): SendWindow {
  return isWithinSendWindow(now, timeZone) ? { open: true } : { open: false, next: nextSendWindow(now, timeZone) };
}

export type SendStop =
  | { reason: "configuration_required" }
  | { reason: "retry"; code: string; retryAfterSeconds?: number };

export type SendRemindersResult = {
  outcome: "sent" | "deferred" | "garage_inactive" | "stopped";
  counts: { claimed: number; sent: number; failed: number; refused: number; released: number; record_errors: number };
  /** Closed window: when to try again. */
  deferUntil?: Date;
  /** Set when the batch stopped early because sending cannot work right now. */
  stop?: SendStop;
  /** True when time ran out with more rows possibly due (enqueue a continuation). */
  more: boolean;
};

export type SendRemindersInput = {
  garage: ReminderSendGarage;
  repo: ReminderSendRepo;
  channelFor: (kind: ChannelKind) => MessageChannel;
  now: () => Date;
  /** Epoch ms (per `clock`) after which no new send starts. */
  deadline: number;
  clock?: () => number;
  batchSize?: number;
  env?: UrlEnvironment;
  createToken?: (now: Date) => ReminderLinkToken;
};

const ACTIVE_GARAGE_STATUSES = new Set(["onboarding", "active"]);

function providerFor(channel: MessageChannel) {
  if (channel.mode === "mock") return "mock";
  return channel.kind === "email" ? "resend" : "twilio";
}

/** `invalid_recipient:21211`: our code and the provider's, safe to store (no address or text). */
export function failureCode(result: SendFailure, prefix?: string) {
  const parts = [prefix, result.code, result.providerCode === undefined ? undefined : String(result.providerCode)].filter(Boolean);
  return parts.join(":").replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 64);
}

async function safeSend(channel: MessageChannel, message: Parameters<MessageChannel["send"]>[0]): Promise<SendResult> {
  try {
    return await channel.send(message);
  } catch {
    // A channel that throws may have handed the message over already.
    return { ok: false, code: "provider_error", retryable: false, providerCode: "exception", ambiguous: true };
  }
}

export async function sendGarageReminders(input: SendRemindersInput): Promise<SendRemindersResult> {
  const clock = input.clock ?? Date.now;
  const batchSize = Math.max(1, input.batchSize ?? REMINDER_SEND_BATCH);
  const createToken = input.createToken ?? createReminderLinkToken;
  const { garage, repo } = input;
  const counts = { claimed: 0, sent: 0, failed: 0, refused: 0, released: 0, record_errors: 0 };

  if (!ACTIVE_GARAGE_STATUSES.has(garage.status)) return { outcome: "garage_inactive", counts, more: false };
  const window = sendWindow(input.now(), garage.timezone);
  if (!window.open) return { outcome: "deferred", counts, deferUntil: window.next, more: false };

  const unsubscribeUrl = garageUrl(garage, "/unsubscribe", input.env);
  let stop: SendStop | undefined;
  let more = false;

  while (!stop) {
    if (clock() >= input.deadline) {
      more = true;
      break;
    }
    const now = input.now();
    const rows = await repo.claim(garage.id, now, batchSize);
    counts.claimed += rows.length;
    if (rows.length === 0) break;

    const untouched: string[] = [];
    for (const reminder of rows) {
      if (stop || clock() >= input.deadline) {
        untouched.push(reminder.id);
        continue;
      }

      const token = createToken(now);
      const composed = composeReminder({
        reminder,
        garageName: garage.name,
        link: garageUrl(garage, reminderLinkPath(token.token), input.env),
        unsubscribeUrl,
      });
      if (!composed.ok) {
        await repo.markFailed(garage.id, reminder.id, null, composed.reason);
        counts.refused += 1;
        continue;
      }
      const to = reminder.channel === "email" ? reminder.email : reminder.phone;
      if (!to) {
        await repo.markFailed(garage.id, reminder.id, null, "no_address");
        counts.failed += 1;
        continue;
      }

      const channel = input.channelFor(reminder.channel);
      let messageId: string;
      try {
        ({ messageId } = await repo.prepare(garage.id, reminder, {
          linkHash: token.hash,
          linkExpiresAt: token.expiresAt,
          body: composed.body,
          to,
          provider: providerFor(channel),
        }));
      } catch {
        untouched.push(reminder.id);
        stop = { reason: "retry", code: "prepare_failed" };
        continue;
      }

      const result = await safeSend(channel, {
        garageId: garage.id,
        to,
        body: composed.body,
        ...(composed.subject ? { subject: composed.subject } : {}),
        idempotencyKey: `reminder_send:${reminder.id}`,
      });

      try {
        if (result.ok) {
          await repo.markSent(garage.id, reminder.id, messageId, { providerMessageId: result.providerMessageId, status: result.status }, input.now());
          counts.sent += 1;
        } else if (result.ambiguous) {
          // A14: the provider may have accepted it. Recorded, never resent automatically.
          await repo.markFailed(garage.id, reminder.id, messageId, failureCode(result, "ambiguous"));
          counts.failed += 1;
        } else if (result.code === "opted_out") {
          await repo.markFailed(garage.id, reminder.id, messageId, failureCode(result));
          if (reminder.channel !== "email" && reminder.phone) await repo.optOut(garage.id, reminder.phone);
          counts.failed += 1;
        } else if (result.code === "configuration_required") {
          await repo.release(garage.id, [reminder.id], [messageId]);
          counts.released += 1;
          stop = { reason: "configuration_required" };
        } else if (result.code === "rate_limited" || result.retryable) {
          await repo.release(garage.id, [reminder.id], [messageId]);
          counts.released += 1;
          stop = { reason: "retry", code: failureCode(result), retryAfterSeconds: result.retryAfterSeconds };
        } else {
          await repo.markFailed(garage.id, reminder.id, messageId, failureCode(result));
          counts.failed += 1;
        }
      } catch {
        // The send happened (or definitely did not) but recording it failed. The row stays
        // `sending`, which is never retried (A51), so nothing is sent twice.
        counts.record_errors += 1;
        if (result.ok) counts.sent += 1;
      }
    }

    if (untouched.length > 0) {
      await repo.release(garage.id, untouched, []);
      counts.released += untouched.length;
      if (!stop) more = true;
    }
    if (rows.length < batchSize) break;
  }

  return { outcome: stop ? "stopped" : "sent", counts, ...(stop ? { stop } : {}), more };
}
