import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { databaseError } from "@/lib/jobs/types";
import type { ClaimedCampaignSend } from "./compose";
import type { CampaignSendRepo } from "./send";

// Service-role storage for the campaign send loop. Every statement names the
// garage; updates of a claimed row also require status `sending`, so a row a
// webhook or another worker has moved on is never overwritten. The messages
// row is linked from campaign_sends.message_id, so delivery receipts reach the
// send through the messages_campaign_send_status trigger.

const MESSAGE_STATUSES = new Set(["queued", "sent", "delivered", "failed"]);

export function createSupabaseCampaignSendRepo(db: SupabaseClient): CampaignSendRepo {
  return {
    async claim(garageId, now, limit) {
      const { data, error } = await db.rpc("claim_campaign_sends", { p_garage_id: garageId, p_now: now.toISOString(), p_limit: limit });
      if (error) throw databaseError("claim_campaign_sends", error);
      return (data ?? []) as ClaimedCampaignSend[];
    },

    async prepare(garageId, send, prepared) {
      const message = await db
        .from("messages")
        .insert({
          garage_id: garageId,
          customer_id: send.customer_id,
          channel: send.channel,
          direction: "outbound",
          to_address: prepared.to,
          body: prepared.body,
          provider: prepared.provider,
          status: "sending",
        })
        .select("id")
        .single();
      if (message.error || !message.data) throw databaseError("messages.insert", message.error);
      const messageId = (message.data as { id: string }).id;

      const updated = await db
        .from("campaign_sends")
        .update({
          link_token_hash: prepared.linkHash,
          link_expires_at: prepared.linkExpiresAt.toISOString(),
          body: prepared.body.slice(0, 4000),
          message_id: messageId,
        })
        .eq("garage_id", garageId)
        .eq("id", send.id)
        .eq("status", "sending");
      if (updated.error) {
        await db.from("messages").delete().eq("garage_id", garageId).eq("id", messageId);
        throw databaseError("campaign_sends.prepare", updated.error);
      }
      return { messageId };
    },

    async markSent(garageId, sendId, messageId, result, sentAt) {
      const status = MESSAGE_STATUSES.has(result.status) ? result.status : "queued";
      const send = await db
        .from("campaign_sends")
        .update({
          status: status === "delivered" ? "delivered" : "sent",
          provider_msg_id: result.providerMessageId,
          sent_at: sentAt.toISOString(),
          ...(status === "delivered" ? { delivered_at: sentAt.toISOString() } : {}),
          error_code: null,
        })
        .eq("garage_id", garageId)
        .eq("id", sendId)
        .eq("status", "sending");
      const message = await db.from("messages").update({ status, provider_msg_id: result.providerMessageId }).eq("garage_id", garageId).eq("id", messageId);
      if (send.error) throw databaseError("campaign_sends.sent", send.error);
      if (message.error) throw databaseError("messages.sent", message.error);
    },

    async markFailed(garageId, sendId, messageId, errorCode) {
      if (messageId) {
        const message = await db.from("messages").update({ status: "failed", error_code: errorCode }).eq("garage_id", garageId).eq("id", messageId);
        if (message.error) throw databaseError("messages.failed", message.error);
      }
      const send = await db
        .from("campaign_sends")
        .update({ status: "failed", error_code: errorCode })
        .eq("garage_id", garageId)
        .eq("id", sendId)
        .eq("status", "sending");
      if (send.error) throw databaseError("campaign_sends.failed", send.error);
    },

    async release(garageId, sendIds, messageIds) {
      if (sendIds.length > 0) {
        const send = await db
          .from("campaign_sends")
          .update({ status: "scheduled", link_token_hash: null, link_expires_at: null, body: null, error_code: null, message_id: null, claimed_at: null })
          .eq("garage_id", garageId)
          .in("id", sendIds)
          .eq("status", "sending");
        if (send.error) throw databaseError("campaign_sends.release", send.error);
      }
      if (messageIds.length > 0) {
        const removed = await db.from("messages").delete().eq("garage_id", garageId).in("id", messageIds);
        if (removed.error) throw databaseError("messages.release", removed.error);
      }
    },

    async optOut(garageId, phone) {
      const { error } = await db.rpc("apply_messaging_keyword", { p_garage_id: garageId, p_phone: phone, p_intent: "stop" });
      if (error) throw databaseError("apply_messaging_keyword", error);
    },
  };
}
