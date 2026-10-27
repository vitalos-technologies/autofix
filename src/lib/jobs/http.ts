import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { CRON_JOBS, cronDedupeKey, isCronAuthorized, isCronJobName } from "./cron";
import { createSupabaseJobQueue } from "./queue";
import { drainJobs, type DrainSummary } from "./runner";
import { JOB_KINDS, type JobQueue } from "./types";

// Shared by GET /api/cron/[job] and POST /api/jobs/drain. Responses carry
// counts only: never job payloads, garage ids or names.

/** Vercel Hobby functions run for up to 60 s; the drain stops claiming after 20 s. */
export const CRON_DRAIN_BUDGET_MS = 20_000;
export const MAX_DRAIN_BUDGET_MS = 50_000;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function drainBody(summary: DrainSummary) {
  const { ok, stoppedBy, claimed, done, retried, failed, timedOut, byKind, elapsedMs } = summary;
  return { ok, stoppedBy, claimed, done, retried, failed, timedOut, byKind, elapsedMs };
}

export type JobRouteDeps = {
  db?: SupabaseClient | null;
  queue?: JobQueue;
  drain?: typeof drainJobs;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
};

/** GET /api/cron/[job]: queue the job's fan-out kinds once per period, then drain for up to 20 s. */
export async function handleCronRequest(request: Request, job: string, deps: JobRouteDeps = {}) {
  if (!isCronAuthorized(request.headers.get("authorization"), deps.env)) return json({ code: "unauthorized" }, 401);
  if (!isCronJobName(job)) return json({ code: "unknown_job" }, 404);
  const db = deps.db === undefined ? createAdminClient() : deps.db;
  if (!db) return json({ code: "not_configured" }, 503);
  const queue = deps.queue ?? createSupabaseJobQueue(db);
  const now = (deps.now ?? (() => new Date()))();

  const kinds = CRON_JOBS[job];
  try {
    for (const kind of kinds) await queue.enqueue(kind, {}, { dedupeKey: cronDedupeKey(kind, now) });
  } catch {
    return json({ code: "queue_unavailable" }, 503);
  }
  const summary = await (deps.drain ?? drainJobs)({ db, queue, budgetMs: CRON_DRAIN_BUDGET_MS, env: deps.env });
  return json({ job, queued: kinds.length, drain: drainBody(summary) }, summary.ok ? 200 : 500);
}

const drainRequestSchema = z
  .object({
    kinds: z.array(z.enum(JOB_KINDS)).min(1).max(JOB_KINDS.length).optional(),
    budgetMs: z.number().int().min(1_000).max(MAX_DRAIN_BUDGET_MS).optional(),
  })
  .strict();

/** POST /api/jobs/drain: run due jobs now (an external scheduler, or after a deploy). */
export async function handleDrainRequest(request: Request, deps: JobRouteDeps = {}) {
  if (!isCronAuthorized(request.headers.get("authorization"), deps.env)) return json({ code: "unauthorized" }, 401);

  const raw = await request.text();
  let input: z.infer<typeof drainRequestSchema> = {};
  if (raw.trim()) {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ code: "unsupported_media_type" }, 415);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ code: "invalid_json" }, 400);
    }
    const parsed = drainRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "invalid_request", issues: parsed.error.issues.map((issue) => issue.path.join(".") || "body") }, 422);
    input = parsed.data;
  }

  const db = deps.db === undefined ? createAdminClient() : deps.db;
  if (!db) return json({ code: "not_configured" }, 503);
  const summary = await (deps.drain ?? drainJobs)({
    db,
    queue: deps.queue,
    kinds: input.kinds,
    budgetMs: input.budgetMs ?? CRON_DRAIN_BUDGET_MS,
    env: deps.env,
  });
  return json({ drain: drainBody(summary) }, summary.ok ? 200 : 500);
}
