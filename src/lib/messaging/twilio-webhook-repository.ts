import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseJobQueue } from "@/lib/jobs/queue";
import { databaseError } from "@/lib/jobs/types";
import type { DeliveryStatus } from "./channel";
import { isLaterStatus } from "./twilio";
import type { CallRecord, KeywordResult, TwilioWebhookRepo } from "./twilio-webhooks";

// Service-role storage for the Twilio webhooks. Garage-scoped writes name the
// garage the number routed to; Twilio's message and call ids are unique
// across garages, so delivery receipts and call updates find their row by id.

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
/** Rank of call statuses: a later callback never moves a call back. */
const CALL_RANK: Record<string, number> = {
  queued: 0, initiated: 1, ringing: 2, "in-progress": 3, completed: 4, busy: 4, failed: 4, "no-answer": 4, canceled: 4,
};

/** messages.status / reminder_sends.status as a DeliveryStatus for ordering (`sending` = not yet accepted). */
function asDelivery(status: string | null | undefined): DeliveryStatus | null {
  if (status === "sending" || status === "queued") return "queued";
  if (status === "sent" || status === "delivered" || status === "failed") return status;
  return null;
}

function twilioErrorCode(errorCode: number | null) {
  return errorCode === null ? null : `twilio:${errorCode}`.slice(0, 64);
}

export function createSupabaseTwilioWebhookRepo(db: SupabaseClient): TwilioWebhookRepo {
  return {
    async claimEvent(eventKey, kind, providerSid) {
      const { data, error } = await db.rpc("claim_twilio_webhook_event", { p_event_key: eventKey, p_kind: kind, p_provider_sid: providerSid });
      if (error) throw databaseError("claim_twilio_webhook_event", error);
      return data === true;
    },

    async finishEvent(eventKey, status, outcome = null, errorCode = null) {
      const { error } = await db.rpc("finish_twilio_webhook_event", {
        p_event_key: eventKey,
        p_status: status,
        p_outcome: outcome,
        p_error_code: errorCode,
      });
      if (error) throw databaseError("finish_twilio_webhook_event", error);
    },

    async findGarageByNumber(number) {
      const { data, error } = await db
        .from("garage_phone_numbers")
        .select("garage_id,purpose,garages!inner(name)")
        .eq("number", number)
        .not("provider_sid", "is", null)
        .maybeSingle();
      if (error) throw databaseError("garage_phone_numbers.route", error);
      if (!data) return null;
      const row = data as { garage_id: string; purpose: string; garages: { name: string } | { name: string }[] };
      const garage = Array.isArray(row.garages) ? row.garages[0] : row.garages;
      return { garageId: row.garage_id, purpose: row.purpose, garageName: garage?.name ?? "The garage" };
    },

    async findCustomerId(garageId, phone) {
      const { data, error } = await db.from("customers").select("id").eq("garage_id", garageId).eq("phone", phone).maybeSingle();
      if (error) throw databaseError("customers.by_phone", error);
      return (data as { id: string } | null)?.id ?? null;
    },

    async insertInboundMessage(row) {
      const { data, error } = await db
        .from("messages")
        .insert({
          garage_id: row.garageId,
          customer_id: row.customerId,
          channel: row.channel,
          direction: "inbound",
          from_address: row.from,
          to_address: row.to,
          body: row.body,
          provider: "twilio",
          provider_msg_id: row.providerMessageId,
          status: "received",
        })
        .select("id")
        .single();
      if (error?.code === "23505") return null;
      if (error || !data) throw databaseError("messages.inbound", error);
      return { id: (data as { id: string }).id };
    },

    async applyKeyword(garageId, phone, intent) {
      const { data, error } = await db.rpc("apply_messaging_keyword", { p_garage_id: garageId, p_phone: phone, p_intent: intent });
      if (error) throw databaseError("apply_messaging_keyword", error);
      const result = (data ?? {}) as Partial<KeywordResult>;
      return { customers: Number(result.customers ?? 0), cancelled: Number(result.cancelled ?? 0), unchanged: Number(result.unchanged ?? 0) };
    },

    async garagesThatMessaged(phone) {
      const { data, error } = await db
        .from("messages")
        .select("garage_id")
        .eq("direction", "outbound")
        .eq("to_address", phone)
        .in("channel", ["sms", "whatsapp"])
        .gte("created_at", new Date(Date.now() - TWELVE_MONTHS_MS).toISOString())
        .limit(500);
      if (error) throw databaseError("messages.garages_for_number", error);
      return [...new Set(((data ?? []) as Array<{ garage_id: string }>).map((row) => row.garage_id))];
    },

    async applyDeliveryStatus(providerMessageId, status, errorCode) {
      let messages = 0;
      let reminders = 0;

      const message = await db.from("messages").select("id,garage_id,status,direction").eq("provider_msg_id", providerMessageId).maybeSingle();
      if (message.error) throw databaseError("messages.by_provider_id", message.error);
      const messageRow = message.data as { id: string; garage_id: string; status: string; direction: string } | null;
      if (messageRow && messageRow.direction === "outbound" && isLaterStatus(asDelivery(messageRow.status), status)) {
        const updated = await db
          .from("messages")
          .update(status === "failed" ? { status, error_code: twilioErrorCode(errorCode) ?? "twilio:failed" } : { status }, { count: "exact" })
          .eq("garage_id", messageRow.garage_id)
          .eq("id", messageRow.id)
          .eq("status", messageRow.status);
        if (updated.error) throw databaseError("messages.status", updated.error);
        messages = updated.count ?? 0;
      }

      // A reminder is `sent` once the provider accepted it; receipts only take it to delivered or failed.
      if (status === "delivered" || status === "failed") {
        const send = await db.from("reminder_sends").select("id,garage_id,status").eq("provider_msg_id", providerMessageId).limit(1).maybeSingle();
        if (send.error) throw databaseError("reminder_sends.by_provider_id", send.error);
        const sendRow = send.data as { id: string; garage_id: string; status: string } | null;
        if (sendRow && sendRow.status === "sent" && isLaterStatus("sent", status)) {
          const updated = await db
            .from("reminder_sends")
            .update(status === "failed" ? { status, error_code: twilioErrorCode(errorCode) ?? "twilio:failed" } : { status }, { count: "exact" })
            .eq("garage_id", sendRow.garage_id)
            .eq("id", sendRow.id)
            .eq("status", "sent");
          if (updated.error) throw databaseError("reminder_sends.status", updated.error);
          reminders = updated.count ?? 0;
        }
      }
      return { messages, reminders };
    },

    async recordCall(call: CallRecord) {
      const existing = await db.from("calls").select("id,garage_id,status,duration_s").eq("provider_call_sid", call.callSid).maybeSingle();
      if (existing.error) throw databaseError("calls.by_sid", existing.error);
      const row = existing.data as { id: string; garage_id: string; status: string; duration_s: number | null } | null;

      if (!row) {
        const inserted = await db.from("calls").insert({
          garage_id: call.garageId,
          provider_call_sid: call.callSid,
          from_number: call.from,
          to_number: call.to,
          status: call.status,
          missed: call.missed,
          duration_s: call.durationSeconds,
        });
        if (!inserted.error) return "created";
        if (inserted.error.code !== "23505") throw databaseError("calls.insert", inserted.error);
        // Two callbacks raced: fall through to an update of the row the other one created.
        return this.recordCall(call);
      }

      if (row.garage_id !== call.garageId) return "unchanged";
      const forward = (CALL_RANK[call.status] ?? 0) > (CALL_RANK[row.status] ?? 0);
      const patch: Record<string, unknown> = {};
      if (forward) patch.status = call.status;
      if (call.durationSeconds !== null && call.durationSeconds !== row.duration_s) patch.duration_s = call.durationSeconds;
      if (Object.keys(patch).length === 0) return "unchanged";
      const updated = await db.from("calls").update(patch).eq("garage_id", row.garage_id).eq("id", row.id);
      if (updated.error) throw databaseError("calls.update", updated.error);
      return "updated";
    },

    async queueHelpReply(garageId, inboundMessageId) {
      await createSupabaseJobQueue(db).enqueue("messages.reply", { garageId, inboundMessageId, kind: "help" }, {
        garageId,
        dedupeKey: `messages.reply:help:${inboundMessageId}`,
      });
    },
  };
}
