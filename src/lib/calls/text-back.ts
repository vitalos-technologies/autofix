import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { databaseError } from "@/lib/jobs/types";
import type { ChannelKind, MessageChannel } from "@/lib/messaging/channel";
import { classifyInbound } from "@/lib/messaging/keywords";
import { isUkMobileE164 } from "@/lib/messaging/phone";
import { DEFAULT_TEMPLATES, renderTemplate } from "@/lib/messaging/templates";
import { failureCode } from "@/lib/reminders/send";
import { firstName } from "@/lib/reminders/compose";
import { garageUrl, type GarageUrlSubject, type UrlEnvironment } from "@/lib/tenancy/urls";

// The missed-call text-back (P4.1, SPEC "Missed calls"; DECISIONS A160-A162).
//
// A service message to someone who has just rung the garage, so it needs no
// stored marketing consent and is sent at any hour; but opt-outs always win
// (the customer's opted_out_at, or the latest STOP/START this number sent the
// garage), at most one goes to a number per garage in 24 hours (in SQL, under
// a lock: claim_call_text_back), and only to UK mobiles. The garage's
// `missed_call` reminder rule decides whether it goes (enabled), what it says
// (template: {garage}, {link}, {first_name}) and how (channel: sms, whatsapp,
// or the caller's own channel when they are a customer; email rules use SMS,
// the caller's number is all we have). The messages row is written before the
// send (A14) and the result recorded on it; a failed send is never retried.

/** A text-back long after the call (a stuck queue) would confuse more than help. */
export const TEXT_BACK_MAX_DELAY_MS = 10 * 60 * 1000;

export type TextBackCall = { id: string; fromNumber: string | null; missed: boolean; textBackMessageId: string | null; createdAt: string };
export type TextBackRule = { enabled: boolean; channel: string; template: string };
export type TextBackCustomer = { name: string | null; channel: string | null; optedOutAt: string | null };
export type TextBackClaim = { status: "claimed"; messageId: string; to: string } | { status: "skipped"; reason: string };

export interface TextBackRepo {
  loadCall(garageId: string, callId: string): Promise<TextBackCall | null>;
  loadRule(garageId: string): Promise<TextBackRule | null>;
  loadCustomer(garageId: string, phone: string): Promise<TextBackCustomer | null>;
  /** The most recent STOP or START this number texted the garage, if any. */
  latestKeyword(garageId: string, phone: string): Promise<"stop" | "start" | null>;
  claim(garageId: string, callId: string, message: { channel: "sms" | "whatsapp"; body: string; provider: string }): Promise<TextBackClaim>;
  recordResult(garageId: string, messageId: string, result: { status: string; providerMessageId?: string; errorCode?: string }): Promise<void>;
}

export type TextBackOutcome =
  | "sent" | "failed" | "not_found" | "not_missed" | "withheld" | "already_sent" | "not_mobile" | "too_late"
  | "rule_disabled" | "opted_out" | "template_placeholders" | "recent_text_back";

export async function sendCallTextBack(input: {
  garage: GarageUrlSubject & { id: string; name: string };
  callId: string;
  repo: TextBackRepo;
  channelFor: (kind: ChannelKind) => MessageChannel;
  now: Date;
  env?: UrlEnvironment;
}): Promise<{ outcome: TextBackOutcome; channel?: "sms" | "whatsapp" }> {
  const { garage, repo } = input;
  const call = await repo.loadCall(garage.id, input.callId);
  if (!call) return { outcome: "not_found" };
  if (!call.missed) return { outcome: "not_missed" };
  if (!call.fromNumber) return { outcome: "withheld" };
  if (call.textBackMessageId) return { outcome: "already_sent" };
  if (!isUkMobileE164(call.fromNumber)) return { outcome: "not_mobile" };
  if (input.now.getTime() - Date.parse(call.createdAt) > TEXT_BACK_MAX_DELAY_MS) return { outcome: "too_late" };

  const rule = await repo.loadRule(garage.id);
  if (!rule?.enabled) return { outcome: "rule_disabled" };
  const customer = await repo.loadCustomer(garage.id, call.fromNumber);
  if (customer?.optedOutAt) return { outcome: "opted_out" };
  // A number that is not a customer can still have texted STOP to the garage.
  if ((await repo.latestKeyword(garage.id, call.fromNumber)) === "stop") return { outcome: "opted_out" };

  const channel: "sms" | "whatsapp" = rule.channel === "whatsapp" || (rule.channel === "customer" && customer?.channel === "whatsapp") ? "whatsapp" : "sms";
  const rendered = renderTemplate(rule.template.trim() || DEFAULT_TEMPLATES.missed_call.body, {
    garage: garage.name,
    link: garageUrl(garage, "/", input.env),
    first_name: firstName(customer?.name) || undefined,
  }, { channel });
  if (rendered.missingPlaceholders.length > 0 || rendered.unknownPlaceholders.length > 0) return { outcome: "template_placeholders" };

  const sender = input.channelFor(channel);
  const claim = await repo.claim(garage.id, call.id, { channel, body: rendered.text, provider: sender.mode === "mock" ? "mock" : "twilio" });
  if (claim.status === "skipped") return { outcome: claim.reason as TextBackOutcome };

  // From here on the message row exists: a failure is recorded, never retried (A14).
  let result;
  try {
    result = await sender.send({ garageId: garage.id, to: claim.to, body: rendered.text, idempotencyKey: `call_text_back:${call.id}` });
  } catch {
    result = { ok: false as const, code: "provider_error" as const, retryable: false, providerCode: "exception", ambiguous: true };
  }
  await repo.recordResult(garage.id, claim.messageId, result.ok
    ? { status: result.status, providerMessageId: result.providerMessageId }
    : { status: "failed", errorCode: failureCode(result, result.ambiguous ? "ambiguous" : undefined) });
  return { outcome: result.ok ? "sent" : "failed", channel };
}

export function createSupabaseTextBackRepo(db: SupabaseClient): TextBackRepo {
  return {
    async loadCall(garageId, callId) {
      const { data, error } = await db
        .from("calls")
        .select("id,from_number,missed,text_back_message_id,created_at")
        .eq("garage_id", garageId)
        .eq("id", callId)
        .maybeSingle();
      if (error) throw databaseError("calls.load", error);
      const row = data as { id: string; from_number: string | null; missed: boolean; text_back_message_id: string | null; created_at: string } | null;
      return row ? { id: row.id, fromNumber: row.from_number, missed: row.missed, textBackMessageId: row.text_back_message_id, createdAt: row.created_at } : null;
    },

    async loadRule(garageId) {
      const { data, error } = await db.from("reminder_rules").select("enabled,channel,template").eq("garage_id", garageId).eq("kind", "missed_call").maybeSingle();
      if (error) throw databaseError("reminder_rules.missed_call", error);
      return (data as TextBackRule | null) ?? null;
    },

    async loadCustomer(garageId, phone) {
      const { data, error } = await db
        .from("customers")
        .select("name,channel,opted_out_at")
        .eq("garage_id", garageId)
        .eq("phone", phone)
        .is("anonymised_at", null)
        .maybeSingle();
      if (error) throw databaseError("customers.by_phone", error);
      const row = data as { name: string | null; channel: string | null; opted_out_at: string | null } | null;
      return row ? { name: row.name, channel: row.channel, optedOutAt: row.opted_out_at } : null;
    },

    async latestKeyword(garageId, phone) {
      const { data, error } = await db
        .from("messages")
        .select("body")
        .eq("garage_id", garageId)
        .eq("direction", "inbound")
        .eq("from_address", phone)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw databaseError("messages.keywords", error);
      for (const row of (data ?? []) as Array<{ body: string | null }>) {
        const intent = classifyInbound(row.body);
        if (intent === "stop" || intent === "start") return intent;
      }
      return null;
    },

    async claim(garageId, callId, message) {
      const { data, error } = await db.rpc("claim_call_text_back", {
        p_garage_id: garageId,
        p_call_id: callId,
        p_channel: message.channel,
        p_body: message.body,
        p_provider: message.provider,
      });
      if (error) throw databaseError("claim_call_text_back", error);
      const result = (data ?? {}) as { status?: string; reason?: string; message_id?: string; to?: string };
      if (result.status === "claimed" && result.message_id && result.to) return { status: "claimed", messageId: result.message_id, to: result.to };
      return { status: "skipped", reason: result.reason ?? "not_found" };
    },

    async recordResult(garageId, messageId, result) {
      const { error } = await db
        .from("messages")
        .update(result.status === "failed"
          ? { status: "failed", error_code: result.errorCode ?? "failed" }
          : { status: result.status, provider_msg_id: result.providerMessageId ?? null })
        .eq("garage_id", garageId)
        .eq("id", messageId);
      if (error) throw databaseError("messages.text_back_result", error);
    },
  };
}
