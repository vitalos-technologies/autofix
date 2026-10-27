import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { databaseError, type EnqueueOptions, type JobKind, type JobQueue, type JobRow } from "./types";

// The Postgres job queue through PostgREST (service role): enqueue_job(),
// claim_jobs() (for update skip locked), finish_job() and fail_job()
// (backoff 2^attempts minutes; `failed` after max_attempts or retry false).

const DEDUPE_KEY_MAX = 200;
const ERROR_MAX = 2000;

export function createSupabaseJobQueue(db: SupabaseClient): JobQueue {
  return {
    async enqueue(kind, payload, options = {}) {
      const { data, error } = await db.rpc("enqueue_job", {
        p_kind: kind,
        p_payload: payload,
        p_run_at: options.runAt ? options.runAt.toISOString() : null,
        p_dedupe_key: options.dedupeKey ? options.dedupeKey.slice(0, DEDUPE_KEY_MAX) : null,
        p_garage_id: options.garageId ?? null,
      });
      if (error || !data) throw databaseError("enqueue_job", error);
      return (Array.isArray(data) ? data[0] : data) as JobRow;
    },

    async claim(kind, limit) {
      const { data, error } = await db.rpc("claim_jobs", { p_kind: kind, p_limit: Math.max(1, Math.trunc(limit)) });
      if (error) throw databaseError("claim_jobs", error);
      return (data ?? []) as JobRow[];
    },

    async finish(id) {
      const { data, error } = await db.rpc("finish_job", { p_id: id });
      if (error) throw databaseError("finish_job", error);
      return data === true;
    },

    async fail(id, message, retry) {
      const { data, error } = await db.rpc("fail_job", { p_id: id, p_error: message.slice(0, ERROR_MAX), p_retry: retry });
      if (error) throw databaseError("fail_job", error);
      return typeof data === "string" ? data : null;
    },
  };
}

/**
 * Queue a job with the service role. The same `dedupeKey` returns the job
 * already queued (whatever its state). Throws when the database is not
 * configured or the insert fails.
 */
export async function enqueueJob(
  kind: JobKind,
  payload: Record<string, unknown>,
  options: EnqueueOptions & { client?: SupabaseClient | null } = {},
): Promise<JobRow> {
  const client = options.client === undefined ? createAdminClient() : options.client;
  if (!client) throw databaseError("enqueue_job", { code: "not_configured" });
  return createSupabaseJobQueue(client).enqueue(kind, payload, options);
}
