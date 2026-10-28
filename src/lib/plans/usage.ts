import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { allowanceFor, getPlansConfig, type UsageMetric } from "./config";
import type { Plan } from "./features";

// Usage metering (P5.2): SMS segments and AI front desk minutes per garage per garage-local month,
// in `usage_events` through record_usage() (service role, idempotent by source key). Metering never
// blocks or fails a message: at or over the allowance the message still goes and the overage is
// recorded for billing at cost when the month closes (close_usage_month()).

export type UsageRecorder = (input: {
  garageId: string;
  metric: UsageMetric;
  quantity: number;
  sourceKey: string;
  at?: Date;
}) => Promise<boolean>;

/** Records usage with the service role. Never throws; false when it could not or the source was already counted. */
export const recordUsage: UsageRecorder = async ({ garageId, metric, quantity, sourceKey, at }) => {
  if (!(quantity > 0) || !garageId || !sourceKey) return false;
  try {
    const client = createAdminClient();
    if (!client) return false;
    const { data, error } = await client.rpc("record_usage", {
      p_garage_id: garageId,
      p_metric: metric,
      p_quantity: Math.min(Math.round(quantity * 100) / 100, 100000),
      p_source_key: sourceKey.slice(0, 200),
      p_at: (at ?? new Date()).toISOString(),
    });
    if (error) {
      console.warn(JSON.stringify({ scope: "usage", event: "record_failed", metric, code: error.code ?? "unknown" }));
      return false;
    }
    return data === true;
  } catch (error) {
    console.warn(JSON.stringify({ scope: "usage", event: "record_failed", metric, code: error instanceof Error ? error.name : "unknown" }));
    return false;
  }
};

export type UsageLine = {
  metric: UsageMetric;
  used: number;
  /** null while the allowance is a placeholder (not set by Temitope yet). */
  allowance: number | null;
  /** Over the allowance this month, billed at cost; null while the allowance is unset. */
  overage: number | null;
  /** 0–100 for the meter; null without an allowance. */
  percent: number | null;
};

export function usageLine(metric: UsageMetric, used: number, allowance: number | null): UsageLine {
  if (allowance === null) return { metric, used, allowance, overage: null, percent: null };
  const percent = allowance === 0 ? (used > 0 ? 100 : 0) : Math.min(100, Math.round((used / allowance) * 100));
  return { metric, used, allowance, overage: Math.max(0, used - allowance), percent };
}

/** This month's usage for the selected garage (owners/managers; RLS client with `x-garage-id`). */
export async function loadUsageMonth(
  client: SupabaseClient,
  { plan, monthFirst, env = process.env }: { plan: Plan; monthFirst: string; env?: Record<string, string | undefined> },
): Promise<{ sms: UsageLine; ai: UsageLine } | null> {
  const { data, error } = await client.rpc("garage_usage_month", { p_month: monthFirst });
  if (error) return null;
  const totals = new Map<string, number>();
  for (const row of (data ?? []) as { metric: string; quantity: number | string }[]) totals.set(row.metric, Number(row.quantity) || 0);
  const config = getPlansConfig(env);
  return {
    sms: usageLine("sms_segments", totals.get("sms_segments") ?? 0, allowanceFor(config, plan, "sms_segments")),
    ai: usageLine("ai_minutes", totals.get("ai_minutes") ?? 0, allowanceFor(config, plan, "ai_minutes")),
  };
}
