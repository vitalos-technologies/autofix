import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseCampaignSendRepo } from "@/lib/campaigns/repository";
import { sendGarageCampaigns, type CampaignSendRepo } from "@/lib/campaigns/send";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { loadJobGarage } from "../garages";
import { campaignsSendPayload, parsePayload } from "../payloads";
import { utcSlot } from "../periods";
import { databaseError, retryableJobError, type JobHandler } from "../types";

// `campaigns.send` (P5.5), drained like reminders.send: queued by
// schedule_campaign() for the campaign's send time, and by the cron (every 10
// minutes on Vercel Pro; daily on Hobby). Without a garage: queue one job per
// garage that has campaign sends due. With a garage: send them inside the send
// window, or re-queue for when it next opens (quiet hours, CLAUDE.md rule 5).
// The plan is checked in SQL at claim time (Essentials garages send nothing).

export type CampaignsSendDeps = {
  repo?: (db: SupabaseClient) => CampaignSendRepo;
  channelFor?: (kind: ChannelKind, env: Readonly<Record<string, string | undefined>>) => MessageChannel;
  batchSize?: number;
  garagesWithDueSends?: (db: SupabaseClient, now: Date) => Promise<string[]>;
};

/** Garages with campaign sends due by `now` (service role). */
export async function garagesWithDueCampaignSends(db: SupabaseClient, now: Date): Promise<string[]> {
  const { data, error } = await db
    .from("campaign_sends")
    .select("garage_id")
    .eq("status", "scheduled")
    .lte("send_at", now.toISOString())
    .order("send_at", { ascending: true })
    .limit(2000);
  if (error) throw databaseError("campaign_sends.due_garages", error);
  return [...new Set(((data ?? []) as Array<{ garage_id: string }>).map((row) => row.garage_id))];
}

export function createCampaignsSendHandler(deps: CampaignsSendDeps = {}): JobHandler {
  const repoFor = deps.repo ?? createSupabaseCampaignSendRepo;
  const channelFor = deps.channelFor ?? ((kind, env) => getChannel(kind, env));
  const dueGarages = deps.garagesWithDueSends ?? garagesWithDueCampaignSends;

  return async (payload, context) => {
    const input = parsePayload(campaignsSendPayload, payload, context.job);
    const now = context.now();

    if (!input.garageId) {
      const garages = await dueGarages(context.db, now);
      const slot = utcSlot(now, 10);
      for (const garageId of garages) {
        await context.queue.enqueue("campaigns.send", { garageId }, { garageId, dedupeKey: `campaigns.send:${garageId}:${slot}` });
      }
      return { outcome: "fanned_out", counts: { garages: garages.length } };
    }

    const garageId = input.garageId;
    const garage = await loadJobGarage(context.db, garageId);
    const result = await sendGarageCampaigns({
      garage,
      repo: repoFor(context.db),
      channelFor: (kind) => channelFor(kind, context.env),
      now: context.now,
      deadline: context.deadline,
      clock: context.clock,
      batchSize: deps.batchSize,
      env: context.env,
    });

    if (result.outcome === "deferred" && result.deferUntil) {
      await context.queue.enqueue("campaigns.send", { garageId }, {
        garageId,
        runAt: result.deferUntil,
        dedupeKey: `campaigns.send:${garageId}:window:${result.deferUntil.toISOString()}`,
      });
      return { outcome: "deferred", counts: result.counts };
    }

    if (result.stop?.reason === "configuration_required") {
      context.log.warn("messaging_not_configured", result.counts);
      return { outcome: "configuration_required", counts: result.counts };
    }

    if (result.stop?.reason === "retry") {
      if (result.stop.retryAfterSeconds !== undefined) {
        const runAt = new Date(now.getTime() + Math.max(1, result.stop.retryAfterSeconds) * 1000);
        await context.queue.enqueue("campaigns.send", { garageId }, { garageId, runAt, dedupeKey: `campaigns.send:${garageId}:retry:${context.job.id}` });
        return { outcome: "rate_limited", counts: result.counts };
      }
      throw retryableJobError("SEND_RETRY", result.stop.code);
    }

    if (result.more) {
      await context.queue.enqueue("campaigns.send", { garageId }, { garageId, dedupeKey: `campaigns.send:${garageId}:more:${context.job.id}` });
    }
    return { outcome: result.outcome, counts: { ...result.counts, more: result.more ? 1 : 0 } };
  };
}

export const campaignsSendHandler = createCampaignsSendHandler();
