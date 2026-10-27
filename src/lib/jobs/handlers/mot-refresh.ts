import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfiguredMotHistoryLookup } from "@/lib/vehicle/configured-provider";
import type { MotHistoryLookup } from "@/lib/vehicle/dvsa";
import { toIsoDate } from "@/lib/vehicle/mot";
import { VehicleLookupError } from "@/lib/vehicle/provider";
import { ACTIVE_GARAGE_STATUSES, listGarages } from "../garages";
import { motRefreshPayload, parsePayload } from "../payloads";
import { addDays, localDate, utcDate } from "../periods";
import { databaseError, permanentJobError, type JobContext, type JobHandler } from "../types";

// `mot.refresh` (SPEC "Nightly MOT refresh", 02:00 on Pro; the daily cron on
// Hobby). Without a garage: one job per active garage with MOT switched on.
// With a garage: vehicles whose owner has reminder consent (not opted out or
// anonymised) and whose MOT expiry is unknown, within 60 days, or last
// checked more than 30 days ago (and not checked in the last 20 hours), in
// id order and in batches. Each is looked up in DVSA MOT History (the client
// paces itself below DVSA's limits); a rate limit stops the batch and queues
// the rest for later. When DVSA has another expiry, the vehicle is updated
// and its pending MOT reminders for the old date are cancelled in SQL; the
// garage's reminders are then re-scheduled for the new dates.

export const MOT_REFRESH_BATCH = 25;
const DUE_WINDOW_DAYS = 60;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const RECHECK_AFTER_MS = 20 * 60 * 60 * 1000;
/** Consecutive "unavailable" answers after which the batch stops (DVSA is down). */
const MAX_CONSECUTIVE_ERRORS = 3;

type Candidate = { id: string; registration: string; mot_expiry: string | null };

export type MotRefreshDeps = {
  lookup?: (env: Readonly<Record<string, string | undefined>>) => MotHistoryLookup | null;
  batchSize?: number;
};

export async function listMotRefreshCandidates(
  db: SupabaseClient,
  garageId: string,
  options: { today: string; now: Date; after?: string; limit: number },
): Promise<Candidate[]> {
  const dueBy = addDays(options.today, DUE_WINDOW_DAYS);
  const stale = new Date(options.now.getTime() - STALE_AFTER_MS).toISOString();
  const recheck = new Date(options.now.getTime() - RECHECK_AFTER_MS).toISOString();
  let query = db
    .from("vehicles")
    .select("id,registration,mot_expiry,customers!inner(reminder_consent,opted_out_at,anonymised_at)")
    .eq("garage_id", garageId)
    .eq("customers.reminder_consent", true)
    .is("customers.opted_out_at", null)
    .is("customers.anonymised_at", null)
    // never checked, OR checked > 30 days ago, OR (checked > 20 h ago AND expiry unknown or within 60 days)
    .or(`mot_checked_at.is.null,mot_checked_at.lt.${stale},and(mot_checked_at.lt.${recheck},or(mot_expiry.is.null,mot_expiry.lte.${dueBy}))`);
  if (options.after) query = query.gt("id", options.after);
  const { data, error } = await query.order("id", { ascending: true }).limit(options.limit);
  if (error) throw databaseError("vehicles.mot_candidates", error);
  return ((data ?? []) as Array<Candidate & Record<string, unknown>>).map((row) => ({ id: row.id, registration: row.registration, mot_expiry: row.mot_expiry ?? null }));
}

/**
 * Records one DVSA answer: `mot_checked_at` always; a different expiry replaces the stored one and
 * cancels the vehicle's scheduled MOT reminders for any other date (schedule_reminders re-arms them
 * if the date comes back). Returns whether the expiry changed and how many reminders were cancelled.
 */
export async function recordMotCheck(db: SupabaseClient, garageId: string, vehicle: Candidate, expiry: string | null, now: Date) {
  const changed = Boolean(expiry && expiry !== vehicle.mot_expiry);
  const update = await db
    .from("vehicles")
    .update(changed ? { mot_checked_at: now.toISOString(), mot_expiry: expiry } : { mot_checked_at: now.toISOString() })
    .eq("garage_id", garageId)
    .eq("id", vehicle.id);
  if (update.error) throw databaseError("vehicles.mot_check", update.error);
  if (!changed || !expiry) return { changed: false, movedForward: false, cancelled: 0 };

  const cancelled = await db
    .from("reminder_sends")
    .update({ status: "cancelled", skip_reason: "due_date_changed" }, { count: "exact" })
    .eq("garage_id", garageId)
    .eq("vehicle_id", vehicle.id)
    .eq("kind", "mot")
    .eq("status", "scheduled")
    .neq("due_date", expiry);
  if (cancelled.error) throw databaseError("reminder_sends.mot_cancel", cancelled.error);
  return { changed: true, movedForward: vehicle.mot_expiry !== null && expiry > vehicle.mot_expiry, cancelled: cancelled.count ?? 0 };
}

async function fanOut(context: JobContext) {
  const garages = await listGarages(context.db, { statuses: ACTIVE_GARAGE_STATUSES, motEnabled: true });
  const day = utcDate(context.now());
  for (const garage of garages) {
    await context.queue.enqueue("mot.refresh", { garageId: garage.id }, { garageId: garage.id, dedupeKey: `mot.refresh:${garage.id}:${day}` });
  }
  return { outcome: "fanned_out", counts: { garages: garages.length } };
}

export function createMotRefreshHandler(deps: MotRefreshDeps = {}): JobHandler {
  const lookupFor = deps.lookup ?? getConfiguredMotHistoryLookup;
  const batchSize = Math.max(1, deps.batchSize ?? MOT_REFRESH_BATCH);

  return async (payload, context) => {
    const input = parsePayload(motRefreshPayload, payload, context.job);
    if (!input.garageId) return fanOut(context);
    const garageId = input.garageId;

    const { data: garage, error } = await context.db.from("garages").select("id,timezone,mot_enabled,status").eq("id", garageId).maybeSingle();
    if (error) throw databaseError("garages.load", error);
    if (!garage) throw permanentJobError("GARAGE_NOT_FOUND");
    const row = garage as { timezone?: string | null; mot_enabled?: boolean | null; status: string };
    if (!row.mot_enabled || !(ACTIVE_GARAGE_STATUSES as readonly string[]).includes(row.status)) return { outcome: "mot_disabled" };

    const lookup = lookupFor(context.env);
    if (!lookup) {
      context.log.warn("mot_source_not_configured");
      return { outcome: "not_configured" };
    }

    const now = context.now();
    const today = localDate(now, row.timezone || "Europe/London");
    const candidates = await listMotRefreshCandidates(context.db, garageId, { today, now, after: input.after, limit: batchSize });
    const counts = { candidates: candidates.length, checked: 0, changed: 0, moved_forward: 0, cancelled: 0, not_found: 0, errors: 0 };
    let lastId = input.after;
    let consecutiveErrors = 0;
    let stop: { retryAfterMs: number } | null = null;
    let timedOut = false;

    for (const vehicle of candidates) {
      if (context.clock() >= context.deadline) {
        timedOut = true;
        break;
      }
      let expiry: string | null = null;
      try {
        const history = await lookup.getMotHistory(vehicle.registration);
        expiry = toIsoDate(history.mot.motExpiry ?? history.mot.motTestDueDate) ?? null;
        consecutiveErrors = 0;
      } catch (lookupError) {
        const code = lookupError instanceof VehicleLookupError ? lookupError.code : "unavailable";
        if (code === "rate_limited") {
          stop = { retryAfterMs: lookupError instanceof VehicleLookupError && lookupError.retryAfterMs ? lookupError.retryAfterMs : 60_000 };
          break;
        }
        if (code === "unavailable") {
          counts.errors += 1;
          consecutiveErrors += 1;
          lastId = vehicle.id;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            stop = { retryAfterMs: 15 * 60_000 };
            break;
          }
          continue;
        }
        // not_found / invalid: DVSA has nothing for this registration. Note the check, keep the date.
        counts.not_found += 1;
      }
      const recorded = await recordMotCheck(context.db, garageId, vehicle, expiry, now);
      counts.checked += 1;
      if (recorded.changed) counts.changed += 1;
      if (recorded.movedForward) counts.moved_forward += 1;
      counts.cancelled += recorded.cancelled;
      lastId = vehicle.id;
    }

    if (counts.changed > 0) {
      // Step 4: reminder rows for the new dates (idempotent; also cancels anything else stale).
      const scheduled = await context.db.rpc("schedule_reminders", { p_garage_id: garageId, p_today: today });
      if (scheduled.error) throw databaseError("schedule_reminders", scheduled.error);
    }

    // One continuation per attempt (its key carries this job's id): later after a stop, now after a
    // full batch or when time ran out. The cursor is the last vehicle handled, so nothing is skipped.
    const more = stop !== null || timedOut || candidates.length === batchSize;
    if (stop || (more && lastId && lastId !== input.after)) {
      await context.queue.enqueue("mot.refresh", lastId ? { garageId, after: lastId } : { garageId }, {
        garageId,
        ...(stop ? { runAt: new Date(now.getTime() + stop.retryAfterMs) } : {}),
        dedupeKey: `mot.refresh:${garageId}:${stop ? "retry" : "after"}:${context.job.id}`,
      });
    }
    return { outcome: stop ? "rate_limited" : "refreshed", counts: { ...counts, more: more ? 1 : 0 } };
  };
}

export const motRefreshHandler = createMotRefreshHandler();
