/**
 * The job queue for browser specs (local stack only).
 *
 * `PLAYWRIGHT_CRON_SECRET` is the `CRON_SECRET` playwright.garage.config.ts gives the server, so a spec can
 * call `POST /api/jobs/drain` and `GET /api/cron/[job]` like Vercel Cron does. Like the booking keys there,
 * the fallback is a local-only value, not a secret.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const PLAYWRIGHT_CRON_SECRET = process.env.CRON_SECRET || "playwright-local-cron-secret-not-a-secret";

export type QueuedJob = { id: string; kind: string; status: string; garage_id: string | null; payload: Record<string, unknown> };

/** Queues one job through `enqueue_job()` (service role), as the fan-out jobs do for each garage. */
export async function enqueueTestJob(
  service: SupabaseClient,
  kind: string,
  payload: Record<string, unknown>,
  options: { garageId: string; dedupeKey: string },
): Promise<QueuedJob> {
  const { data, error } = await service.rpc("enqueue_job", {
    p_kind: kind,
    p_payload: payload,
    p_run_at: null,
    p_dedupe_key: options.dedupeKey,
    p_garage_id: options.garageId,
  });
  if (error || !data) throw new Error(`enqueue_job ${kind} failed: ${error?.message ?? "no row"}`);
  return (Array.isArray(data) ? data[0] : data) as QueuedJob;
}

export async function jobStatus(service: SupabaseClient, id: string) {
  const { data, error } = await service.from("jobs").select("status,attempts,last_error").eq("id", id).single();
  if (error || !data) throw new Error(`Could not read job ${id}: ${error?.message}`);
  return data as { status: string; attempts: number; last_error: string | null };
}
