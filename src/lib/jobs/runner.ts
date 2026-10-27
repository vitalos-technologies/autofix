import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { createJobLogger } from "./log";
import { createSupabaseJobQueue } from "./queue";
import { JOB_DEFINITIONS } from "./registry";
import { JobError, safeErrorCode, type JobDefinition, type JobKind, type JobLogger, type JobQueue, type JobRow } from "./types";

// drainJobs(): works through due jobs kind by kind (JOB_KINDS order), one
// claim at a time, until the queue is empty or the time budget is spent.
// Each attempt runs with its kind's timeout; then finish_job(), or
// fail_job() with retry (backoff) unless the handler threw a permanent
// JobError. Delivery is at least once (A49), so handlers are idempotent.

/** Below this much budget no new job is claimed (a claim must have time to finish). */
const MIN_SLICE_MS = 750;
/** Handlers stop starting new external work this long before their attempt times out. */
const DEADLINE_MARGIN_MS = 3_000;

export type DrainOptions = {
  /** Only these kinds (default: every registered kind). */
  kinds?: readonly JobKind[];
  /** Total wall-clock budget for the drain. */
  budgetMs: number;
  db?: SupabaseClient | null;
  queue?: JobQueue;
  definitions?: readonly JobDefinition[];
  now?: () => Date;
  /** Monotonic-enough clock for the budget (ms). */
  clock?: () => number;
  log?: JobLogger;
  env?: Readonly<Record<string, string | undefined>>;
};

export type KindSummary = { done: number; retried: number; failed: number };

export type DrainSummary = {
  ok: boolean;
  /** Why the drain stopped. */
  stoppedBy: "empty" | "budget" | "not_configured" | "queue_error";
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  timedOut: number;
  byKind: Partial<Record<JobKind, KindSummary>>;
  elapsedMs: number;
};

type AttemptOutcome = { kind: "done" | "retried" | "failed"; timedOut: boolean };

const TIMEOUT = Symbol("timeout");

async function runAttempt(
  definition: JobDefinition,
  job: JobRow,
  remainingMs: number,
  base: { queue: JobQueue; db: SupabaseClient; now: () => Date; clock: () => number; env: Readonly<Record<string, string | undefined>>; log: JobLogger },
): Promise<AttemptOutcome> {
  const timeoutMs = Math.max(1, Math.min(definition.timeoutMs, remainingMs));
  const started = base.clock();
  const log = createJobLoggerFor(base.log, job);
  const context = {
    job,
    now: base.now,
    deadline: started + Math.max(0, timeoutMs - Math.min(DEADLINE_MARGIN_MS, timeoutMs / 4)),
    clock: base.clock,
    queue: base.queue,
    db: base.db,
    log,
    env: base.env,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  let result: Awaited<ReturnType<JobDefinition["handler"]>> | typeof TIMEOUT;
  let failure: unknown = null;
  try {
    result = await Promise.race([definition.handler(job.payload, context), timeout]);
  } catch (error) {
    result = undefined;
    failure = error ?? new Error("unknown");
  } finally {
    clearTimeout(timer);
  }
  const ms = base.clock() - started;

  if (result === TIMEOUT) {
    // The attempt may still be running in the background; every handler is idempotent (A49).
    const status = await base.queue.fail(job.id, "TIMEOUT", true);
    log.warn("job_timeout", { ms, attempts: job.attempts, status });
    return { kind: status === "failed" ? "failed" : "retried", timedOut: true };
  }

  if (failure !== null) {
    const retry = failure instanceof JobError ? failure.retry : true;
    const code = safeErrorCode(failure);
    const status = await base.queue.fail(job.id, code, retry);
    log.error("job_failed", { ms, attempts: job.attempts, error: code, retry, status });
    return { kind: status === "queued" ? "retried" : "failed", timedOut: false };
  }

  await base.queue.finish(job.id);
  const fields: Record<string, string | number> = { ms, attempts: job.attempts };
  if (result && result.outcome) fields.outcome = result.outcome;
  for (const [key, value] of Object.entries(result?.counts ?? {})) if (typeof value === "number") fields[key] = value;
  log.info("job_done", fields);
  return { kind: "done", timedOut: false };
}

function createJobLoggerFor(parent: JobLogger, job: JobRow): JobLogger {
  const fields = { job_id: job.id, kind: job.kind, garage_id: job.garage_id };
  return {
    info: (event, extra) => parent.info(event, { ...fields, ...extra }),
    warn: (event, extra) => parent.warn(event, { ...fields, ...extra }),
    error: (event, extra) => parent.error(event, { ...fields, ...extra }),
  };
}

/** Runs due jobs until the queue is empty or `budgetMs` is spent. Never throws. */
export async function drainJobs(options: DrainOptions): Promise<DrainSummary> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const summary: DrainSummary = { ok: true, stoppedBy: "empty", claimed: 0, done: 0, retried: 0, failed: 0, timedOut: 0, byKind: {}, elapsedMs: 0 };
  const finish = () => ({ ...summary, elapsedMs: clock() - startedAt });

  const db = options.db === undefined ? createAdminClient() : options.db;
  if (!db) return { ...finish(), ok: false, stoppedBy: "not_configured" };
  const queue = options.queue ?? createSupabaseJobQueue(db);
  const log = options.log ?? createJobLogger();
  const wanted = options.kinds ? new Set(options.kinds) : null;
  const definitions = (options.definitions ?? JOB_DEFINITIONS).filter((definition) => !wanted || wanted.has(definition.kind));
  const endAt = startedAt + Math.max(0, options.budgetMs);
  const base = { queue, db, now: options.now ?? (() => new Date()), clock, env: options.env ?? process.env, log };

  try {
    for (const definition of definitions) {
      while (true) {
        if (endAt - clock() < MIN_SLICE_MS) {
          summary.stoppedBy = "budget";
          return finish();
        }
        const [job] = await queue.claim(definition.kind, 1);
        if (!job) break;
        summary.claimed += 1;
        const outcome = await runAttempt(definition, job, endAt - clock(), base);
        const perKind = (summary.byKind[definition.kind] ??= { done: 0, retried: 0, failed: 0 });
        perKind[outcome.kind] += 1;
        summary[outcome.kind] += 1;
        if (outcome.timedOut) summary.timedOut += 1;
      }
    }
  } catch (error) {
    log.error("drain_failed", { error: safeErrorCode(error) });
    return { ...finish(), ok: false, stoppedBy: "queue_error" };
  }
  return finish();
}
