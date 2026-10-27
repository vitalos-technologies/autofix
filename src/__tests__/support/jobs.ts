import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createJobLogger } from "@/lib/jobs/log";
import type { EnqueueOptions, JobContext, JobKind, JobQueue, JobRow } from "@/lib/jobs/types";

/** A queued-job record from the recording queue. */
export type Enqueued = { kind: JobKind; payload: Record<string, unknown>; options: EnqueueOptions };

export function jobRow(kind: JobKind, payload: Record<string, unknown> = {}, garageId: string | null = null, id = "00000000-0000-4000-8000-0000000000a1"): JobRow {
  return { id, kind, garage_id: garageId, payload, dedupe_key: null, run_at: new Date().toISOString(), status: "running", attempts: 1, max_attempts: 5 };
}

/** A queue that records what handlers enqueue (and never runs anything). */
export function recordingQueue() {
  const enqueued: Enqueued[] = [];
  const queue: JobQueue = {
    enqueue: vi.fn(async (kind, payload, options = {}) => {
      enqueued.push({ kind, payload, options });
      return jobRow(kind, payload, options.garageId ?? null, `00000000-0000-4000-8000-${String(enqueued.length).padStart(12, "0")}`);
    }),
    claim: vi.fn(async () => []),
    finish: vi.fn(async () => true),
    fail: vi.fn(async () => "queued"),
  };
  return { queue, enqueued };
}

export function jobContext(input: {
  job: JobRow;
  db: SupabaseClient;
  now: Date;
  queue?: JobQueue;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  deadline?: number;
  lines?: string[];
}): JobContext {
  const lines = input.lines ?? [];
  return {
    job: input.job,
    db: input.db,
    now: () => input.now,
    clock: input.clock ?? (() => 0),
    deadline: input.deadline ?? Number.MAX_SAFE_INTEGER,
    queue: input.queue ?? recordingQueue().queue,
    env: input.env ?? {},
    log: createJobLogger({ job_id: input.job.id }, (_level, line) => lines.push(line)),
  };
}
