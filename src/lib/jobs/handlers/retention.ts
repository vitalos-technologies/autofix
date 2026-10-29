import "server-only";

import { listGarages } from "../garages";
import { parsePayload, retentionPayload } from "../payloads";
import { utcDate } from "../periods";
import { databaseError, type JobHandler } from "../types";

// `retention` (daily; replaces SOB's /api/cron/retention). Without a garage:
// one job per garage (every garage, cancelled ones too: the limits apply to
// whatever data a garage still holds, A24), then platform housekeeping that
// holds no personal data: vehicle_facts rows older than 30 days (the cache
// is only trusted for 24 hours) and finished jobs older than 14 days; and
// Pitline's own line, apply_platform_call_retention() (voicemail links after
// 12 months, A420). With a
// garage: apply_enquiry_retention() (bookings, enquiries, customers) and
// apply_message_retention() (message bodies, reminder bodies, voicemail
// links after 12 months, A57).

export const VEHICLE_FACTS_RETENTION_DAYS = 30;
export const FINISHED_JOBS_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export const retentionHandler: JobHandler = async (payload, context) => {
  const input = parsePayload(retentionPayload, payload, context.job);
  const now = context.now();

  if (!input.garageId) {
    const garages = await listGarages(context.db);
    const day = utcDate(now);
    for (const garage of garages) {
      await context.queue.enqueue("retention", { garageId: garage.id }, { garageId: garage.id, dedupeKey: `retention:${garage.id}:${day}` });
    }

    const facts = await context.db
      .from("vehicle_facts")
      .delete({ count: "exact" })
      .lt("fetched_at", new Date(now.getTime() - VEHICLE_FACTS_RETENTION_DAYS * DAY_MS).toISOString());
    if (facts.error) throw databaseError("vehicle_facts.purge", facts.error);

    const jobs = await context.db
      .from("jobs")
      .delete({ count: "exact" })
      .in("status", ["done", "failed"])
      .lt("finished_at", new Date(now.getTime() - FINISHED_JOBS_RETENTION_DAYS * DAY_MS).toISOString());
    if (jobs.error) throw databaseError("jobs.purge", jobs.error);

    const platformCalls = await context.db.rpc("apply_platform_call_retention");
    if (platformCalls.error) throw databaseError("apply_platform_call_retention", platformCalls.error);

    return {
      outcome: "fanned_out",
      counts: {
        garages: garages.length,
        vehicle_facts: facts.count ?? 0,
        jobs: jobs.count ?? 0,
        platform_voicemails_cleared: typeof platformCalls.data === "number" ? platformCalls.data : 0,
      },
    };
  }

  const enquiries = await context.db.rpc("apply_enquiry_retention", { p_garage_id: input.garageId });
  if (enquiries.error) throw databaseError("apply_enquiry_retention", enquiries.error);
  const messages = await context.db.rpc("apply_message_retention", { p_garage_id: input.garageId });
  if (messages.error) throw databaseError("apply_message_retention", messages.error);
  return {
    outcome: "applied",
    counts: {
      anonymised: typeof enquiries.data === "number" ? enquiries.data : 0,
      messages_cleared: typeof messages.data === "number" ? messages.data : 0,
    },
  };
};
