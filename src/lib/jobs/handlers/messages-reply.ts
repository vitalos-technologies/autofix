import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { withOptOut } from "@/lib/messaging/templates";
import { failureCode } from "@/lib/reminders/send";
import { formatPhoneForDisplay } from "@/lib/tenancy/contact";
import type { Garage } from "@/lib/tenancy/garage";
import { loadJobGarage } from "../garages";
import { messagesReplyPayload, parsePayload } from "../payloads";
import { databaseError, permanentJobError, type JobHandler } from "../types";

// `messages.reply`: an automatic answer to an inbound text, queued by the
// Twilio webhook so it can answer Twilio at once. For now only HELP: the
// garage's name and how to reach it. It goes out on the channel the text came
// in on, from the number it was sent to (Twilio's default when replying), in
// mock mode unless MESSAGING_MODE=live. HELP answers are allowed after STOP
// (they answer the customer). Not retried after the send was attempted (A14);
// the same answer to the same number within 10 minutes is not sent again.

const REPEAT_WINDOW_MS = 10 * 60 * 1000;

type InboundRow = { id: string; channel: ChannelKind; direction: string; from_address: string | null; to_address: string | null; customer_id: string | null };

/** "Hartley Road Motors: for help, call 01302 000101 or email hello@example.com. Reply STOP to opt out." */
export function helpReplyBody(garage: Pick<Garage, "name" | "phone" | "email">, channel: ChannelKind) {
  const contact = [
    garage.phone ? `call ${formatPhoneForDisplay(garage.phone)}` : null,
    garage.email ? `email ${garage.email}` : null,
  ].filter(Boolean).join(" or ");
  const text = contact ? `${garage.name}: for help, ${contact}.` : `${garage.name}: thanks for your message. We'll get back to you soon.`;
  return withOptOut(text, channel);
}

export type MessagesReplyDeps = {
  channelFor?: (kind: ChannelKind, env: Readonly<Record<string, string | undefined>>) => MessageChannel;
};

async function recentlyAnswered(db: SupabaseClient, garageId: string, to: string, body: string, now: Date) {
  const { data, error } = await db
    .from("messages")
    .select("id")
    .eq("garage_id", garageId)
    .eq("direction", "outbound")
    .eq("to_address", to)
    .eq("body", body)
    .gte("created_at", new Date(now.getTime() - REPEAT_WINDOW_MS).toISOString())
    .limit(1);
  if (error) throw databaseError("messages.recent_reply", error);
  return (data ?? []).length > 0;
}

export function createMessagesReplyHandler(deps: MessagesReplyDeps = {}): JobHandler {
  const channelFor = deps.channelFor ?? ((kind, env) => getChannel(kind, env));

  return async (payload, context) => {
    const input = parsePayload(messagesReplyPayload, payload, context.job);
    const { data, error } = await context.db
      .from("messages")
      .select("id,channel,direction,from_address,to_address,customer_id")
      .eq("garage_id", input.garageId)
      .eq("id", input.inboundMessageId)
      .maybeSingle();
    if (error) throw databaseError("messages.load", error);
    const inbound = data as InboundRow | null;
    if (!inbound || inbound.direction !== "inbound" || inbound.channel === "email" || !inbound.from_address) {
      throw permanentJobError("INBOUND_NOT_FOUND");
    }

    const garage = await loadJobGarage(context.db, input.garageId);
    const body = helpReplyBody(garage, inbound.channel);
    const now = context.now();
    if (await recentlyAnswered(context.db, garage.id, inbound.from_address, body, now)) return { outcome: "already_answered" };

    const channel = channelFor(inbound.channel, context.env);
    const inserted = await context.db
      .from("messages")
      .insert({
        garage_id: garage.id,
        customer_id: inbound.customer_id,
        channel: inbound.channel,
        direction: "outbound",
        to_address: inbound.from_address,
        from_address: inbound.to_address,
        body,
        provider: channel.mode === "mock" ? "mock" : "twilio",
        status: "sending",
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) throw databaseError("messages.reply_insert", inserted.error);
    const messageId = (inserted.data as { id: string }).id;

    let result;
    try {
      result = await channel.send({ garageId: garage.id, to: inbound.from_address, body, idempotencyKey: `help_reply:${inbound.id}` });
    } catch {
      result = { ok: false as const, code: "provider_error" as const, retryable: false, providerCode: "exception", ambiguous: true };
    }
    const update = result.ok
      ? { status: result.status, provider_msg_id: result.providerMessageId }
      : { status: "failed", error_code: failureCode(result, result.ambiguous ? "ambiguous" : undefined) };
    const recorded = await context.db.from("messages").update(update).eq("garage_id", garage.id).eq("id", messageId);
    if (recorded.error) context.log.warn("reply_record_failed", { error: recorded.error.code ?? "unknown" });
    return { outcome: result.ok ? "sent" : "failed" };
  };
}

export const messagesReplyHandler = createMessagesReplyHandler();
