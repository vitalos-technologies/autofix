// Job queue contract (docs/autofix/ARCHITECTURE.md "Admin, reminders and jobs").
// Pure types and errors: the queue lives in Postgres (`jobs`, enqueue_job(),
// claim_jobs(), finish_job(), fail_job()), handlers in ./handlers.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Every job kind the runner knows, in the order a drain works through them. */
export const JOB_KINDS = [
  "reminders.schedule",
  "reminders.send",
  "notifications.booking",
  "calls.text_back",
  "messages.reply",
  "domains.check",
  "retention",
  "customers.enrich",
  "mot.refresh",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

/** A row of `public.jobs` as claim_jobs() returns it. */
export type JobRow = {
  id: string;
  kind: string;
  garage_id: string | null;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  run_at: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
};

export type EnqueueOptions = {
  /** When the job may run; now when omitted. */
  runAt?: Date;
  /** Unique for ever (A49): put the period in keys of recurring work. */
  dedupeKey?: string;
  /** Set for work that belongs to one garage. */
  garageId?: string | null;
};

/** The queue, as the runner and handlers use it. `createSupabaseJobQueue` is the real one; tests pass fakes. */
export interface JobQueue {
  enqueue(kind: JobKind, payload: Record<string, unknown>, options?: EnqueueOptions): Promise<JobRow>;
  claim(kind: JobKind, limit: number): Promise<JobRow[]>;
  finish(id: string): Promise<boolean>;
  /** `retry: false` fails the job for good (permanent errors, A14 ambiguous sends). Returns the new status. */
  fail(id: string, error: string, retry: boolean): Promise<string | null>;
}

export type JobLogFields = Record<string, string | number | boolean | null | undefined>;

export interface JobLogger {
  info(event: string, fields?: JobLogFields): void;
  warn(event: string, fields?: JobLogFields): void;
  error(event: string, fields?: JobLogFields): void;
}

export type JobContext = {
  job: JobRow;
  /** The clock (injectable in tests). */
  now: () => Date;
  /** Epoch ms (per `clock`) after which a handler must not start new external work (it should return, or enqueue a continuation). */
  deadline: number;
  /** The clock `deadline` is measured on (Date.now unless a test injects one). */
  clock: () => number;
  queue: JobQueue;
  /** Service-role client. */
  db: SupabaseClient;
  /** Structured logger already carrying the job id, kind and garage id. */
  log: JobLogger;
  env: Readonly<Record<string, string | undefined>>;
};

/** What a handler reports: an outcome code and counts, logged with the job (never personal data). */
export type JobResult = { outcome?: string; counts?: Record<string, number | undefined> };

export type JobHandler = (payload: unknown, context: JobContext) => Promise<JobResult | void>;

export type JobDefinition = {
  kind: JobKind;
  handler: JobHandler;
  /** Hard limit per attempt; the runner gives up on the attempt (and retries it later) after this. */
  timeoutMs: number;
};

/**
 * A job error with a safe code (it goes into `jobs.last_error` and logs, so it
 * never carries a phone number, registration, body or provider free text).
 */
export class JobError extends Error {
  readonly code: string;
  readonly retry: boolean;

  constructor(code: string, options: { retry: boolean; detail?: string }) {
    super(options.detail ? `${code}: ${options.detail}` : code);
    this.name = "JobError";
    this.code = code;
    this.retry = options.retry;
  }
}

/** Fails the job for good (bad payload, missing garage, ambiguous send). */
export function permanentJobError(code: string, detail?: string) {
  return new JobError(code, { retry: false, detail });
}

/** Fails this attempt; fail_job() queues it again with backoff (2, 4, 8 … minutes). */
export function retryableJobError(code: string, detail?: string) {
  return new JobError(code, { retry: true, detail });
}

/** A short, safe description of any error: our codes, Postgres/PostgREST codes, or the error's class name. */
export function safeErrorCode(error: unknown): string {
  if (error instanceof JobError) return error.message.slice(0, 200);
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return `db_${code}`;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name)) return name;
  }
  return "unexpected";
}

/** A Supabase/PostgREST error as a retryable job error with only its code. */
export function databaseError(step: string, error: { code?: string | null } | null | undefined) {
  const code = error?.code && /^[A-Za-z0-9_.-]{1,40}$/.test(error.code) ? error.code : "unknown";
  return retryableJobError("DATABASE_ERROR", `${step} (${code})`);
}
