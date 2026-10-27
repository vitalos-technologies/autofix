import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { createSupabaseReminderSendRepo } from "@/lib/reminders/repository";
import { sendGarageReminders, type ReminderSendRepo } from "@/lib/reminders/send";
import { ACTIVE_GARAGE_STATUSES, listGarages, loadJobGarage } from "../garages";
import { parsePayload, remindersSendPayload } from "../payloads";
import { utcSlot } from "../periods";
import { retryableJobError, type JobHandler } from "../types";

// `reminders.send` (every 10 minutes on Vercel Pro; daily on Hobby): without
// a garage, queue one job per active garage; with a garage, send its due
// reminders inside the send window, or re-queue the job for when the window
// next opens (Sunday, evenings, before 09:00).

export type RemindersSendDeps = {
  repo?: (db: SupabaseClient) => ReminderSendRepo;
  channelFor?: (kind: ChannelKind, env: Readonly<Record<string, string | undefined>>) => MessageChannel;
  batchSize?: number;
};

export function createRemindersSendHandler(deps: RemindersSendDeps = {}): JobHandler {
  const repoFor = deps.repo ?? createSupabaseReminderSendRepo;
  const channelFor = deps.channelFor ?? ((kind, env) => getChannel(kind, env));

  return async (payload, context) => {
    const input = parsePayload(remindersSendPayload, payload, context.job);
    const now = context.now();

    if (!input.garageId) {
      const garages = await listGarages(context.db, { statuses: ACTIVE_GARAGE_STATUSES });
      const slot = utcSlot(now, 10);
      for (const garage of garages) {
        await context.queue.enqueue("reminders.send", { garageId: garage.id }, {
          garageId: garage.id,
          dedupeKey: `reminders.send:${garage.id}:${slot}`,
        });
      }
      return { outcome: "fanned_out", counts: { garages: garages.length } };
    }

    const garageId = input.garageId;
    const garage = await loadJobGarage(context.db, garageId);
    const result = await sendGarageReminders({
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
      // Quiet hours (CLAUDE.md rule 5): try again when the window opens. Every deferral to the same window is one job.
      await context.queue.enqueue("reminders.send", { garageId }, {
        garageId,
        runAt: result.deferUntil,
        dedupeKey: `reminders.send:${garageId}:window:${result.deferUntil.toISOString()}`,
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
        await context.queue.enqueue("reminders.send", { garageId }, { garageId, runAt, dedupeKey: `reminders.send:${garageId}:retry:${context.job.id}` });
        return { outcome: "rate_limited", counts: result.counts };
      }
      throw retryableJobError("SEND_RETRY", result.stop.code);
    }

    if (result.more) {
      await context.queue.enqueue("reminders.send", { garageId }, { garageId, dedupeKey: `reminders.send:${garageId}:more:${context.job.id}` });
    }
    return { outcome: result.outcome, counts: { ...result.counts, more: result.more ? 1 : 0 } };
  };
}

export const remindersSendHandler = createRemindersSendHandler();
