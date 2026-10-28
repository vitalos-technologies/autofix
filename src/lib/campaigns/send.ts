import "server-only";

import { unsubscribeUrl, type UnsubscribeEnv } from "@/lib/consent/unsubscribe-token";
import type { ChannelKind, MessageChannel, SendResult } from "@/lib/messaging/channel";
import { createReminderLinkToken, type ReminderLinkToken } from "@/lib/reminders/link-token";
import { failureCode, sendWindow, type SendStop } from "@/lib/reminders/send";
import { garageUrl, type GarageUrlSubject, type UrlEnvironment } from "@/lib/tenancy/urls";
import { composeCampaign, type ClaimedCampaignSend } from "./compose";

// Sending a garage's due campaign messages (P5.5), the same way reminders go
// (src/lib/reminders/send.ts): only inside the send window (09:00-19:00
// Mon-Sat, garage time zone); rows claimed by claim_campaign_sends(), which
// re-checks consent, opt-out, address and the plan in SQL and marks them
// `sending` before anything is sent (DECISIONS A14). Per row: a fresh link
// token (only its hash is stored), the rendered wording (refused when a
// placeholder has no value), a `messages` row in `sending`, the send through
// getChannel() (SMS is metered by P5.2), and the result on both rows. An
// ambiguous result is recorded as failed and never retried; a definite
// non-send that may work later puts the row back to `scheduled` and stops.

export const CAMPAIGN_SEND_BATCH = 10;

/** Campaign links (`/c/{token}`) open the booking page with the car filled in. */
export function campaignLinkPath(token: string) {
  return `/c/${token}`;
}

export type CampaignSendGarage = GarageUrlSubject & { id: string; name: string; timezone: string; status: string };

export type PreparedCampaignSend = { linkHash: string; linkExpiresAt: Date; body: string; to: string; provider: string };

/** Storage for the send loop. `createSupabaseCampaignSendRepo` is the real one; tests pass fakes. */
export interface CampaignSendRepo {
  claim(garageId: string, now: Date, limit: number): Promise<ClaimedCampaignSend[]>;
  /** Stores the link hash, expiry and body on the send and inserts the outbound `messages` row (`sending`). */
  prepare(garageId: string, send: ClaimedCampaignSend, prepared: PreparedCampaignSend): Promise<{ messageId: string }>;
  markSent(garageId: string, sendId: string, messageId: string, result: { providerMessageId: string; status: string }, sentAt: Date): Promise<void>;
  markFailed(garageId: string, sendId: string, messageId: string | null, errorCode: string): Promise<void>;
  /** Back to `scheduled` (nothing was sent); their messages rows are removed. */
  release(garageId: string, sendIds: string[], messageIds: string[]): Promise<void>;
  /** The provider says this number unsubscribed (Twilio 21610): mirror it as a STOP. */
  optOut(garageId: string, phone: string): Promise<void>;
}

export type SendCampaignsResult = {
  outcome: "sent" | "deferred" | "garage_inactive" | "stopped";
  counts: { claimed: number; sent: number; failed: number; refused: number; released: number; record_errors: number };
  deferUntil?: Date;
  stop?: SendStop;
  more: boolean;
};

export type SendCampaignsInput = {
  garage: CampaignSendGarage;
  repo: CampaignSendRepo;
  channelFor: (kind: ChannelKind) => MessageChannel;
  now: () => Date;
  deadline: number;
  clock?: () => number;
  batchSize?: number;
  env?: UrlEnvironment & UnsubscribeEnv;
  createToken?: (now: Date) => ReminderLinkToken;
};

const ACTIVE_GARAGE_STATUSES = new Set(["onboarding", "active"]);

function providerFor(channel: MessageChannel) {
  if (channel.mode === "mock") return "mock";
  return channel.kind === "email" ? "resend" : "twilio";
}

async function safeSend(channel: MessageChannel, message: Parameters<MessageChannel["send"]>[0]): Promise<SendResult> {
  try {
    return await channel.send(message);
  } catch {
    return { ok: false, code: "provider_error", retryable: false, providerCode: "exception", ambiguous: true };
  }
}

export async function sendGarageCampaigns(input: SendCampaignsInput): Promise<SendCampaignsResult> {
  const clock = input.clock ?? Date.now;
  const batchSize = Math.max(1, input.batchSize ?? CAMPAIGN_SEND_BATCH);
  const createToken = input.createToken ?? createReminderLinkToken;
  const { garage, repo } = input;
  const counts = { claimed: 0, sent: 0, failed: 0, refused: 0, released: 0, record_errors: 0 };

  if (!ACTIVE_GARAGE_STATUSES.has(garage.status)) return { outcome: "garage_inactive", counts, more: false };
  const window = sendWindow(input.now(), garage.timezone);
  if (!window.open) return { outcome: "deferred", counts, deferUntil: window.next, more: false };

  const env = input.env ?? process.env;
  const unsubscribeForm = garageUrl(garage, "/unsubscribe", env);
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
    for (const send of rows) {
      if (stop || clock() >= input.deadline) {
        untouched.push(send.id);
        continue;
      }

      const token = createToken(now);
      const composed = composeCampaign({
        send,
        garageName: garage.name,
        link: garageUrl(garage, campaignLinkPath(token.token), env),
        ...(send.channel === "email" ? { unsubscribeUrl: unsubscribeUrl(garage, send.customer_id, env) ?? unsubscribeForm } : {}),
      });
      if (!composed.ok) {
        await repo.markFailed(garage.id, send.id, null, composed.reason);
        counts.refused += 1;
        continue;
      }
      const to = send.channel === "email" ? send.email : send.phone;
      if (!to) {
        await repo.markFailed(garage.id, send.id, null, "no_address");
        counts.failed += 1;
        continue;
      }

      const channel = input.channelFor(send.channel);
      let messageId: string;
      try {
        ({ messageId } = await repo.prepare(garage.id, send, {
          linkHash: token.hash,
          linkExpiresAt: token.expiresAt,
          body: composed.body,
          to,
          provider: providerFor(channel),
        }));
      } catch {
        untouched.push(send.id);
        stop = { reason: "retry", code: "prepare_failed" };
        continue;
      }

      const result = await safeSend(channel, {
        garageId: garage.id,
        to,
        body: composed.body,
        ...(composed.subject ? { subject: composed.subject } : {}),
        idempotencyKey: `campaign_send:${send.id}`,
      });

      try {
        if (result.ok) {
          await repo.markSent(garage.id, send.id, messageId, { providerMessageId: result.providerMessageId, status: result.status }, input.now());
          counts.sent += 1;
        } else if (result.ambiguous) {
          await repo.markFailed(garage.id, send.id, messageId, failureCode(result, "ambiguous"));
          counts.failed += 1;
        } else if (result.code === "opted_out") {
          await repo.markFailed(garage.id, send.id, messageId, failureCode(result));
          if (send.channel !== "email" && send.phone) await repo.optOut(garage.id, send.phone);
          counts.failed += 1;
        } else if (result.code === "configuration_required") {
          await repo.release(garage.id, [send.id], [messageId]);
          counts.released += 1;
          stop = { reason: "configuration_required" };
        } else if (result.code === "rate_limited" || result.retryable) {
          await repo.release(garage.id, [send.id], [messageId]);
          counts.released += 1;
          stop = { reason: "retry", code: failureCode(result), retryAfterSeconds: result.retryAfterSeconds };
        } else {
          await repo.markFailed(garage.id, send.id, messageId, failureCode(result));
          counts.failed += 1;
        }
      } catch {
        // Recorded nothing: the row stays `sending`, which is never retried, so nothing goes twice.
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
