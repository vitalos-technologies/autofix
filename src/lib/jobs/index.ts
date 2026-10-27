// Job queue entry points (ARCHITECTURE "App": src/lib/jobs/*). Server-only.

export { CRON_JOBS, cronDedupeKey, isCronAuthorized, isCronJobName, type CronJobName } from "./cron";
export { createSupabaseJobQueue, enqueueJob } from "./queue";
export { JOB_DEFINITIONS } from "./registry";
export { drainJobs, type DrainOptions, type DrainSummary } from "./runner";
export {
  isJobKind,
  JOB_KINDS,
  JobError,
  permanentJobError,
  retryableJobError,
  type EnqueueOptions,
  type JobContext,
  type JobDefinition,
  type JobHandler,
  type JobKind,
  type JobQueue,
  type JobResult,
  type JobRow,
} from "./types";
