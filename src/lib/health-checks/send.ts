import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { textToHtml } from "@/lib/email/templates/components";
import { getChannel, type ChannelKind, type MessageChannel, type SendResult } from "@/lib/messaging/channel";
import { withOptOut } from "@/lib/messaging/templates";
import { consumeRateLimit } from "@/lib/rate-limit";
import { failureCode } from "@/lib/reminders/send";
import { createAdminClient } from "@/lib/supabase/server";
import { garageUrl, type GarageUrlSubject } from "@/lib/tenancy/urls";
import { createHealthCheckToken, healthCheckLinkPath, redactHealthCheckLink } from "./token";

// Sending a health check to the customer (P5.3). A service message about their own car, as booking
// texts and staff replies are: no reminder consent is needed and the 09:00–19:00 send window does
// not apply (staff press Send while the car is in), but an opt-out (STOP) always blocks texts and
// WhatsApp (A311). The claim (claim_health_check_send(), service role) checks the member's role,
// the plan, the check and the customer, stores the new link's hash and writes the outbound messages
// row (sending) before anything is sent (A14); the row keeps the body with the link shortened, so
// the token is only ever in the message the customer receives.

export const SEND_RATE_LIMIT = { limit: 20, windowSeconds: 600 } as const;
/** Roles that may send (the same list claim_health_check_send() checks). */
export const SEND_ROLES = ["owner", "manager", "front_desk"] as const;

export function canSendHealthCheck(role: string | null | undefined): boolean {
  return (SEND_ROLES as readonly string[]).includes(role ?? "");
}

export type SendSkipReason =
  | "not_allowed"
  | "plan_required"
  | "not_found"
  | "already_responded"
  | "nothing_checked"
  | "anonymised"
  | "opted_out"
  | "no_address"
  | "no_messaging_number";

export type SendHealthCheckResult =
  | { ok: true; messageId: string; channel: ChannelKind; mode: "mock" | "live" }
  | { ok: false; code: "rate_limited" | "unavailable" | "failed" | SendSkipReason; messageId?: string };

export type SendHealthCheckInput = {
  garage: GarageUrlSubject & { id: string; name: string };
  member: { id: string };
  checkId: string;
  /** Whether the check recommends work (changes the wording). */
  hasRecommendedWork: boolean;
  db?: SupabaseClient | null;
  channelFor?: (kind: ChannelKind) => MessageChannel;
  rateLimit?: (identifier: string, scope: string, limit: number, windowSeconds: number) => Promise<boolean>;
  now?: Date;
};

type Claim = { status: "claimed"; message_id: string; channel: ChannelKind; to: string } | { status: "skipped"; reason: SendSkipReason };

function providerFor(channel: MessageChannel) {
  if (channel.mode === "mock") return "mock";
  return channel.kind === "email" ? "resend" : "twilio";
}

/** The customer's message: who, what and the link. Texts carry the opt-out line. */
export function composeHealthCheckMessage(input: { garageName: string; link: string; hasRecommendedWork: boolean; channel: ChannelKind }) {
  const ask = input.hasRecommendedWork ? "See what we found and approve any extra work" : "See what we found";
  const text = `${input.garageName}: your car's health check is ready. ${ask}: ${input.link}`;
  const body = withOptOut(text, input.channel);
  const subject = `Your car's health check from ${input.garageName}`;
  return { body, subject };
}

/** Sends the health check link on the booking customer's own channel. */
export async function sendHealthCheck(input: SendHealthCheckInput): Promise<SendHealthCheckResult> {
  const allowed = await (input.rateLimit ?? consumeRateLimit)(input.member.id, "health_check_send", SEND_RATE_LIMIT.limit, SEND_RATE_LIMIT.windowSeconds);
  if (!allowed) return { ok: false, code: "rate_limited" };

  const db = input.db === undefined ? createAdminClient() : input.db;
  if (!db) return { ok: false, code: "unavailable" };
  const channelFor = input.channelFor ?? ((kind: ChannelKind) => getChannel(kind));

  // The customer's channel decides the provider recorded on the row, so look it up first.
  const peek = await db
    .from("health_checks")
    .select("id,bookings(customers(channel))")
    .eq("garage_id", input.garage.id)
    .eq("id", input.checkId)
    .maybeSingle();
  if (peek.error) return { ok: false, code: "unavailable" };
  if (!peek.data) return { ok: false, code: "not_found" };
  const booking = (peek.data as { bookings?: unknown }).bookings as { customers?: { channel?: string } | { channel?: string }[] } | null;
  const customer = Array.isArray(booking?.customers) ? booking?.customers[0] : booking?.customers;
  const kind: ChannelKind = customer?.channel === "email" || customer?.channel === "whatsapp" ? customer.channel : "sms";
  const sender = channelFor(kind);

  const token = createHealthCheckToken(input.now ?? new Date());
  const link = garageUrl(input.garage, healthCheckLinkPath(token.token));
  const message = composeHealthCheckMessage({ garageName: input.garage.name, link, hasRecommendedWork: input.hasRecommendedWork, channel: kind });

  const claimed = await db.rpc("claim_health_check_send", {
    p_garage_id: input.garage.id,
    p_check_id: input.checkId,
    p_member_id: input.member.id,
    p_token_hash: token.hash,
    p_expires_at: token.expiresAt.toISOString(),
    p_body: redactHealthCheckLink(message.body, token.token),
    p_provider: providerFor(sender),
  });
  if (claimed.error || !claimed.data) return { ok: false, code: "unavailable" };
  const claim = claimed.data as Claim;
  if (claim.status === "skipped") return { ok: false, code: claim.reason };

  const channel = claim.channel === sender.kind ? sender : channelFor(claim.channel);
  const body = claim.channel === kind ? message.body : composeHealthCheckMessage({ garageName: input.garage.name, link, hasRecommendedWork: input.hasRecommendedWork, channel: claim.channel }).body;
  let result: SendResult;
  try {
    result = await channel.send({
      garageId: input.garage.id,
      to: claim.to,
      body,
      ...(claim.channel === "email" ? { subject: message.subject, html: textToHtml(body) } : {}),
      idempotencyKey: `health_check:${claim.message_id}`,
    });
  } catch {
    // A channel that throws may have handed the message over already: recorded, never resent (A14).
    result = { ok: false, code: "provider_error", retryable: false, providerCode: "exception", ambiguous: true };
  }

  const update = result.ok
    ? { status: result.status, provider_msg_id: result.providerMessageId }
    : { status: "failed", error_code: failureCode(result, result.ambiguous ? "ambiguous" : undefined) || "failed" };
  await db.from("messages").update(update).eq("garage_id", input.garage.id).eq("id", claim.message_id);

  const { data: check } = await db.from("health_checks").select("booking_id").eq("garage_id", input.garage.id).eq("id", input.checkId).maybeSingle();
  const bookingId = (check as { booking_id?: string } | null)?.booking_id;
  if (bookingId) {
    await db.from("booking_events").insert({
      garage_id: input.garage.id,
      booking_id: bookingId,
      type: "notification_sent",
      actor: "staff",
      actor_id: input.member.id,
      data: { kind: claim.channel === "email" ? "customer_email" : claim.channel, status: result.ok ? "sent" : "failed", source: "health_check" },
    });
  }

  if (!result.ok) return { ok: false, code: "failed", messageId: claim.message_id };
  return { ok: true, messageId: claim.message_id, channel: claim.channel, mode: channel.mode };
}
