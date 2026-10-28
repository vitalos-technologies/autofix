import "server-only";

import type { JobHandler } from "@/lib/jobs/types";
import { allowanceFor, getPlansConfig, type UsageMetric } from "./config";
import { isPlan } from "./features";

/**
 * Job kind `plans.expire_trials` (P5.2): ends every Pro trial past `trial_ends_at` (expire_plan_trials()),
 * moving each garage to the plan it chose, else Essentials. Nothing is deleted: Pro data stays and is
 * read-only through the Pro tables' write policies. Gating never waits for this job: an expired trial
 * already counts as Essentials (garage_effective_plan()). Platform job, no payload, idempotent; queued by
 * the `daily` cron.
 */
export const plansExpireTrialsHandler: JobHandler = async (_payload, context) => {
  const { data, error } = await context.db.rpc("expire_plan_trials", { p_now: context.now().toISOString() });
  if (error) throw new Error(`EXPIRE_TRIALS_FAILED: ${error.code ?? "unknown"}`);
  const ended = typeof data === "number" ? data : 0;
  context.log.info("plans.trials_expired", { ended });
  return { outcome: ended ? "expired" : "none", counts: { ended } };
};

const METRICS: UsageMetric[] = ["sms_segments", "ai_minutes"];

/** The first day of the month before `now`'s month in London, as YYYY-MM-DD. */
export function previousMonthFirst(now: Date, timeZone = "Europe/London"): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, "0")}-01`;
}

/**
 * Job kind `billing.close_usage` (P5.2): records last month's SMS segments and AI minutes for every
 * garage with the allowance in force (src/lib/plans/config.ts) and the overage to bill at cost
 * (close_usage_month(), idempotent until reported). While an allowance is still a placeholder the
 * month is recorded as not billable. Platform job; queued by the `daily` cron (re-closing the same month
 * just refreshes it).
 */
export const billingCloseUsageHandler: JobHandler = async (_payload, context) => {
  const month = previousMonthFirst(context.now());
  const config = getPlansConfig(context.env);
  const { data: garages, error } = await context.db
    .from("garages")
    .select("id,plan,trial_ends_at,plan_chosen")
    .neq("status", "cancelled")
    .order("id")
    .limit(5000);
  if (error) throw new Error(`CLOSE_USAGE_FAILED: ${error.code ?? "unknown"}`);
  let closed = 0;
  let billable = 0;
  for (const garage of (garages ?? []) as { id: string; plan: string }[]) {
    if (context.clock() > context.deadline) break;
    const plan = isPlan(garage.plan) ? garage.plan : "essentials";
    for (const metric of METRICS) {
      const result = await context.db.rpc("close_usage_month", {
        p_garage_id: garage.id,
        p_month: month,
        p_metric: metric,
        p_allowance: allowanceFor(config, plan, metric),
      });
      if (result.error) throw new Error(`CLOSE_USAGE_FAILED: ${result.error.code ?? "unknown"}`);
      closed += 1;
      if ((result.data as { status?: string } | null)?.status === "recorded") billable += 1;
    }
  }
  context.log.info("billing.usage_closed", { month, closed, billable });
  return { outcome: closed ? "closed" : "none", counts: { closed, billable } };
};
