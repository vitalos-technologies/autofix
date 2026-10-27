import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getChannel, type ChannelKind, type MessageChannel, type SendResult } from "@/lib/messaging/channel";
import { consumeRateLimit } from "@/lib/rate-limit";
import { failureCode } from "@/lib/reminders/send";
import { createAdminClient } from "@/lib/supabase/server";

// Staff replies from a Messages & calls thread. A reply answers a customer about their own car or
// booking: a service message, so it needs no reminder consent and ignores the send window, but an
// opt-out always wins (A198). The claim and the record are the service role's (staff have no write
// grant on `messages`): claim_staff_reply() checks the member's role, the customer, their opt-out,
// address and channel and the garage's messaging number, and writes the outbound row (sending)
// before anything is sent (A14). The garage and the member always come from the session.

export const REPLY_MAX_LENGTH = 1000;
export const REPLY_RATE_LIMIT = { limit: 20, windowSeconds: 600 } as const;

/** Roles that may reply (the same list claim_staff_reply() checks). */
export const REPLY_ROLES = ["owner", "manager", "front_desk"] as const;

export function canReply(role: string | null | undefined): boolean {
  return (REPLY_ROLES as readonly string[]).includes(role ?? "");
}

export type ReplySkipReason = "not_allowed" | "not_found" | "anonymised" | "opted_out" | "no_address" | "no_messaging_number";

export type ReplyResult =
  | { ok: true; messageId: string; channel: ChannelKind; status: string; mode: "mock" | "live" }
  | { ok: false; code: "empty" | "too_long" | "rate_limited" | "unavailable" | "failed" | ReplySkipReason; messageId?: string };

export type StaffReplyInput = {
  garage: { id: string; name: string };
  member: { id: string };
  customerId: string;
  body: string;
  db?: SupabaseClient | null;
  channelFor?: (kind: ChannelKind) => MessageChannel;
  rateLimit?: (identifier: string, scope: string, limit: number, windowSeconds: number) => Promise<boolean>;
  audit?: typeof recordAdminAudit;
};

type Claim = { status: "claimed"; message_id: string; channel: ChannelKind; to: string } | { status: "skipped"; reason: ReplySkipReason };

function providerFor(channel: MessageChannel) {
  if (channel.mode === "mock") return "mock";
  return channel.kind === "email" ? "resend" : "twilio";
}

/** Sends a member's reply to a customer of their garage on the customer's own channel. */
export async function sendStaffReply(input: StaffReplyInput): Promise<ReplyResult> {
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (!body) return { ok: false, code: "empty" };
  if (body.length > REPLY_MAX_LENGTH) return { ok: false, code: "too_long" };

  const allowed = await (input.rateLimit ?? consumeRateLimit)(input.member.id, "staff_reply", REPLY_RATE_LIMIT.limit, REPLY_RATE_LIMIT.windowSeconds);
  if (!allowed) return { ok: false, code: "rate_limited" };

  const db = input.db === undefined ? createAdminClient() : input.db;
  if (!db) return { ok: false, code: "unavailable" };
  const channelFor = input.channelFor ?? ((kind: ChannelKind) => getChannel(kind));
  const audit = async (outcome: string, channel?: ChannelKind) => {
    try {
      await (input.audit ?? recordAdminAudit)(input.garage.id, {
        actorId: input.member.id,
        action: "message.replied",
        entityType: "customer",
        entityId: input.customerId,
        detail: { outcome, ...(channel ? { channel } : {}) },
      });
    } catch {
      // The audit log is a record, not a gate.
    }
  };

  // Which channel decides the provider recorded on the row, so ask for the customer's first.
  const peek = await db.from("customers").select("channel").eq("garage_id", input.garage.id).eq("id", input.customerId).maybeSingle();
  if (peek.error) return { ok: false, code: "unavailable" };
  const customerChannel = ((peek.data as { channel?: string } | null)?.channel ?? "sms") as ChannelKind;
  const sender = channelFor(customerChannel === "email" || customerChannel === "whatsapp" ? customerChannel : "sms");

  const claimed = await db.rpc("claim_staff_reply", {
    p_garage_id: input.garage.id,
    p_customer_id: input.customerId,
    p_member_id: input.member.id,
    p_body: body,
    p_provider: providerFor(sender),
  });
  if (claimed.error || !claimed.data) return { ok: false, code: "unavailable" };
  const claim = claimed.data as Claim;
  if (claim.status === "skipped") {
    await audit(claim.reason);
    return { ok: false, code: claim.reason };
  }

  const channel = claim.channel === sender.kind ? sender : channelFor(claim.channel);
  let result: SendResult;
  try {
    result = await channel.send({
      garageId: input.garage.id,
      to: claim.to,
      body,
      ...(claim.channel === "email" ? { subject: `Message from ${input.garage.name}` } : {}),
      idempotencyKey: `staff_reply:${claim.message_id}`,
    });
  } catch {
    // A channel that throws may have handed the message over already: recorded, never resent (A14).
    result = { ok: false, code: "provider_error", retryable: false, providerCode: "exception", ambiguous: true };
  }

  const update = result.ok
    ? { status: result.status, provider_msg_id: result.providerMessageId }
    : { status: "failed", error_code: failureCode(result, result.ambiguous ? "ambiguous" : undefined) || "failed" };
  await db.from("messages").update(update).eq("garage_id", input.garage.id).eq("id", claim.message_id);

  await audit(result.ok ? "sent" : "failed", claim.channel);
  if (!result.ok) return { ok: false, code: "failed", messageId: claim.message_id };
  return { ok: true, messageId: claim.message_id, channel: claim.channel, status: result.status, mode: channel.mode };
}
