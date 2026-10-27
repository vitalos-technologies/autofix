import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { databaseError } from "@/lib/jobs/types";
import type { ClaimedReminder } from "./compose";
import type { ReminderSendRepo } from "./send";

// Service-role storage for the reminder send loop. Every statement names the
// garage; updates of a claimed row also require status `sending`, so a row a
// webhook or another worker has moved on is never overwritten.

const MESSAGE_STATUSES = new Set(["queued", "sent", "delivered", "failed"]);

export function createSupabaseReminderSendRepo(db: SupabaseClient): ReminderSendRepo {
  return {
    async claim(garageId, now, limit) {
      const { data, error } = await db.rpc("claim_reminder_sends", { p_garage_id: garageId, p_now: now.toISOString(), p_limit: limit });
      if (error) throw databaseError("claim_reminder_sends", error);
      return (data ?? []) as ClaimedReminder[];
    },

    async prepare(garageId, reminder, prepared) {
      const send = await db
        .from("reminder_sends")
        .update({ link_token_hash: prepared.linkHash, link_expires_at: prepared.linkExpiresAt.toISOString(), body: prepared.body.slice(0, 2000) })
        .eq("garage_id", garageId)
        .eq("id", reminder.id)
        .eq("status", "sending");
      if (send.error) throw databaseError("reminder_sends.prepare", send.error);

      const message = await db
        .from("messages")
        .insert({
          garage_id: garageId,
          customer_id: reminder.customer_id,
          channel: reminder.channel,
          direction: "outbound",
          to_address: prepared.to,
          body: prepared.body,
          provider: prepared.provider,
          status: "sending",
          reminder_send_id: reminder.id,
        })
        .select("id")
        .single();
      if (message.error || !message.data) throw databaseError("messages.insert", message.error);
      return { messageId: (message.data as { id: string }).id };
    },

    async markSent(garageId, reminderId, messageId, result, sentAt) {
      const status = MESSAGE_STATUSES.has(result.status) ? result.status : "queued";
      const message = await db
        .from("messages")
        .update({ status, provider_msg_id: result.providerMessageId })
        .eq("garage_id", garageId)
        .eq("id", messageId);
      const send = await db
        .from("reminder_sends")
        .update({ status: "sent", provider_msg_id: result.providerMessageId, sent_at: sentAt.toISOString(), error_code: null })
        .eq("garage_id", garageId)
        .eq("id", reminderId)
        .eq("status", "sending");
      if (message.error) throw databaseError("messages.sent", message.error);
      if (send.error) throw databaseError("reminder_sends.sent", send.error);
    },

    async markFailed(garageId, reminderId, messageId, errorCode) {
      if (messageId) {
        const message = await db.from("messages").update({ status: "failed", error_code: errorCode }).eq("garage_id", garageId).eq("id", messageId);
        if (message.error) throw databaseError("messages.failed", message.error);
      }
      const send = await db
        .from("reminder_sends")
        .update({ status: "failed", error_code: errorCode })
        .eq("garage_id", garageId)
        .eq("id", reminderId)
        .eq("status", "sending");
      if (send.error) throw databaseError("reminder_sends.failed", send.error);
    },

    async release(garageId, reminderIds, messageIds) {
      if (messageIds.length > 0) {
        const removed = await db.from("messages").delete().eq("garage_id", garageId).in("id", messageIds);
        if (removed.error) throw databaseError("messages.release", removed.error);
      }
      if (reminderIds.length === 0) return;
      const send = await db
        .from("reminder_sends")
        .update({ status: "scheduled", link_token_hash: null, link_expires_at: null, body: null, error_code: null })
        .eq("garage_id", garageId)
        .in("id", reminderIds)
        .eq("status", "sending");
      if (send.error) throw databaseError("reminder_sends.release", send.error);
    },

    async optOut(garageId, phone) {
      const { error } = await db.rpc("apply_messaging_keyword", { p_garage_id: garageId, p_phone: phone, p_intent: "stop" });
      if (error) throw databaseError("apply_messaging_keyword", error);
    },
  };
}
