import "server-only";

import { ACTIVE_GARAGE_STATUSES, listGarages } from "../garages";
import { remindersSchedulePayload, parsePayload } from "../payloads";
import { localDate } from "../periods";
import { databaseError, permanentJobError, type JobHandler } from "../types";

// `reminders.schedule` (daily): without a garage, queue one job per active
// garage (dedupe per garage and local day); with a garage, run
// schedule_reminders(garage, the garage's local today). Idempotent in SQL.

export const remindersScheduleHandler: JobHandler = async (payload, context) => {
  const input = parsePayload(remindersSchedulePayload, payload, context.job);
  const now = context.now();

  if (!input.garageId) {
    const garages = await listGarages(context.db, { statuses: ACTIVE_GARAGE_STATUSES });
    for (const garage of garages) {
      const today = localDate(now, garage.timezone);
      await context.queue.enqueue("reminders.schedule", { garageId: garage.id }, {
        garageId: garage.id,
        dedupeKey: `reminders.schedule:${garage.id}:${today}`,
      });
    }
    return { outcome: "fanned_out", counts: { garages: garages.length } };
  }

  const { data: garage, error } = await context.db.from("garages").select("id,timezone").eq("id", input.garageId).maybeSingle();
  if (error) throw databaseError("garages.load", error);
  if (!garage) throw permanentJobError("GARAGE_NOT_FOUND");
  const today = input.today ?? localDate(now, (garage as { timezone?: string | null }).timezone || "Europe/London");

  const scheduled = await context.db.rpc("schedule_reminders", { p_garage_id: input.garageId, p_today: today });
  if (scheduled.error) throw databaseError("schedule_reminders", scheduled.error);
  const counts = (scheduled.data ?? {}) as Record<string, unknown>;
  return {
    outcome: "scheduled",
    counts: Object.fromEntries(["mot", "service", "review", "cancelled"].map((key) => [key, Number(counts[key] ?? 0)])),
  };
};
