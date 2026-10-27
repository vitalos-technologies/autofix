import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { utcDate, utcSlot } from "./periods";
import type { JobKind } from "./types";

// Cron entry points (GET /api/cron/[job], POST /api/jobs/drain). Vercel Cron
// sends `Authorization: Bearer ${CRON_SECRET}`; anything else is refused.
//
// Each cron name queues the platform ("fan-out") job of its kinds once per
// period: the dedupe key carries the period, so a repeated or overlapping
// call in the same period queues nothing new. Vercel Hobby runs crons once a
// day, so `daily` queues everything; on Vercel Pro (or an external
// scheduler) each kind can have its own cron at its own rate.

/** Each kind's natural period. */
const PERIOD: Partial<Record<JobKind, "day" | { minutes: number }>> = {
  "reminders.schedule": "day",
  "reminders.send": { minutes: 10 },
  "mot.refresh": "day",
  "domains.check": { minutes: 5 },
  retention: "day",
  "platform.close_impersonations": { minutes: 60 },
  "customers.enrich": "day",
};

/** Cron names and the kinds each queues, in drain order. */
export const CRON_JOBS = {
  daily: ["reminders.schedule", "reminders.send", "domains.check", "retention", "platform.close_impersonations", "customers.enrich", "mot.refresh"],
  "reminders.schedule": ["reminders.schedule"],
  "reminders.send": ["reminders.send"],
  "mot.refresh": ["mot.refresh"],
  "domains.check": ["domains.check"],
  retention: ["retention"],
  "platform.close_impersonations": ["platform.close_impersonations"],
  "customers.enrich": ["customers.enrich"],
} as const satisfies Record<string, readonly JobKind[]>;

export type CronJobName = keyof typeof CRON_JOBS;

export function isCronJobName(value: string): value is CronJobName {
  return Object.hasOwn(CRON_JOBS, value);
}

/** The dedupe key of a cron-queued platform job for the period `now` falls in. */
export function cronDedupeKey(kind: JobKind, now: Date): string {
  const period = PERIOD[kind] ?? "day";
  return `cron:${kind}:${period === "day" ? utcDate(now) : utcSlot(now, period.minutes)}`;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time check of `Authorization: Bearer <CRON_SECRET>`. False when the secret is unset or
 * shorter than 16 characters (fail closed), or the header is missing or different.
 */
export function isCronAuthorized(authorization: string | null | undefined, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const secret = env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16 || !authorization) return false;
  // Comparing fixed-length digests keeps the time independent of where (or whether) they differ.
  return timingSafeEqual(digest(authorization.trim()), digest(`Bearer ${secret}`));
}
