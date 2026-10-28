import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePayload } from "@/lib/jobs/payloads";
import { databaseError, permanentJobError, retryableJobError, type JobHandler } from "@/lib/jobs/types";
import { z } from "zod";
import { getAccountingProvider } from "./providers";
import { createSupabaseAccountingRepo } from "./repository";
import { runAccountingSync, type SyncDeps } from "./sync";
import { isAccountingError } from "./types";

// `accounting.sync` (P5.10). With a garage: works through that garage's due items (queued by the
// invoice/payment triggers, "Sync now", "Retry", or a previous run's backoff / Retry-After). Without
// one (the daily cron): queues a run for every garage with due items. A run never throws for a
// provider problem (those are stored per item); only database trouble retries the job.

export const accountingSyncPayload = z.object({ garageId: z.string().uuid().optional() }).strict();

export async function enqueueAccountingSync(db: SupabaseClient, garageId: string, runAt: Date) {
  const { error } = await db.rpc("enqueue_accounting_sync", { p_garage_id: garageId, p_run_at: runAt.toISOString() });
  if (error) throw databaseError("enqueue_accounting_sync", error);
}

export function createAccountingSyncHandler(deps: { run?: typeof runAccountingSync; syncDeps?: (db: SupabaseClient, env: Readonly<Record<string, string | undefined>>) => Omit<SyncDeps, "now" | "deadline" | "clock" | "log"> } = {}): JobHandler {
  const run = deps.run ?? runAccountingSync;
  const syncDeps = deps.syncDeps ?? ((db, env) => ({
    repo: createSupabaseAccountingRepo(db, env),
    provider: (id) => getAccountingProvider(id, { env }),
    enqueue: (garageId, runAt) => enqueueAccountingSync(db, garageId, runAt),
  }));

  return async (payload, context) => {
    const { garageId } = parsePayload(accountingSyncPayload, payload, context.job);
    if (!garageId) {
      const { data, error } = await context.db.rpc("accounting_due_garages", { p_limit: 200 });
      if (error) throw databaseError("accounting_due_garages", error);
      const garages = ((data ?? []) as unknown[]).map(String);
      for (const id of garages) await enqueueAccountingSync(context.db, id, context.now());
      return { outcome: "fanned_out", counts: { garages: garages.length } };
    }
    try {
      const result = await run(garageId, {
        ...syncDeps(context.db, context.env),
        now: context.now,
        deadline: context.deadline,
        clock: context.clock,
        log: context.log,
      });
      context.log.info("accounting.synced", { status: result.status, reason: result.status === "skipped" ? result.reason : undefined });
      if (result.status === "skipped") return { outcome: `skipped_${result.reason}` };
      return { outcome: result.status, counts: { synced: result.synced, failed: result.failed, deferred: result.deferred } };
    } catch (error) {
      if (isAccountingError(error)) {
        if (error.code === "CONFIGURATION_REQUIRED") throw permanentJobError("ACCOUNTING_CONFIGURATION_REQUIRED");
        throw retryableJobError("ACCOUNTING_SYNC_FAILED", error.code);
      }
      throw error;
    }
  };
}

export const accountingSyncHandler = createAccountingSyncHandler();
