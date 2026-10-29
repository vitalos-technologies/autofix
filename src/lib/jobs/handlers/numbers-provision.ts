import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getTwilioNumbersClient, getTwilioNumbersReadiness, isTwilioNumbersError, type TwilioNumbersClient } from "@/lib/messaging/twilio-numbers";
import { readNumbersConfig } from "@/lib/phone-numbers/config";
import { provisionNumbers, type NumbersRepo, type ProvisionSummary } from "@/lib/phone-numbers/provision";
import { createSupabaseNumbersRepo } from "@/lib/phone-numbers/repository";
import { numbersProvisionPayload, parsePayload } from "../payloads";
import type { JobContext, JobHandler } from "../types";

// `numbers.provision` (D22; daily through the `daily` cron, and queued at once when an owner switches the AI
// front desk on). Without a garage: the texting number and every garage waiting for an AI desk number; with a
// garage: that garage only. The decisions are in src/lib/phone-numbers/provision.ts.
//
// It never fails noisily and never loops: Twilio problems become states the garage sees (waiting for the
// upgrade, waiting for approval, waiting list, failed with a reason). Only a stop (429, Twilio 5xx, out of time,
// an unconfirmed purchase) or a busy lease queues one more run, at most MAX_ATTEMPTS times in a row without
// progress; after that the next daily run picks it up. Store errors are ordinary retryable job errors.

/** Long enough to outlive an attempt (18 s) and a purchase still running after it timed out. */
export const NUMBERS_LEASE_SECONDS = 120;
/** No purchase starts with less than this left before the job's deadline (a purchase can take 10 s). */
const PURCHASE_MARGIN_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BUSY_DELAY_MS = 2 * 60_000;
const UNCONFIRMED_DELAY_MS = 2 * 60_000;
const MIN_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

export type NumbersProvisionDeps = {
  client?: (env: Readonly<Record<string, string | undefined>>) => TwilioNumbersClient;
  repo?: (db: SupabaseClient) => NumbersRepo;
};

/** Why the client is not available here, as a safe reason code (names of settings only, never values). */
function unconfiguredReason(env: Readonly<Record<string, string | undefined>>): string {
  const readiness = getTwilioNumbersReadiness(env);
  if (readiness.missing.includes("TWILIO_NUMBERS_MODE")) return "mode_not_live";
  if (readiness.missing.includes("VERCEL_ENV")) return "not_production";
  return "credentials_missing";
}

function counts(summary: ProvisionSummary) {
  return { bought: summary.bought, attached: summary.attached, waiting: summary.waiting, failed: summary.failed, held: summary.held ?? undefined };
}

async function continueLater(context: JobContext, payload: { garageId?: string; attempt?: number }, delayMs: number, progressed: boolean) {
  const attempt = progressed ? (payload.attempt ?? 0) : (payload.attempt ?? 0) + 1;
  if (attempt > MAX_ATTEMPTS) {
    context.log.warn("numbers_provision_gave_up", { attempt: payload.attempt ?? 0 });
    return false;
  }
  await context.queue.enqueue(
    "numbers.provision",
    { ...(payload.garageId ? { garageId: payload.garageId } : {}), ...(attempt > 0 ? { attempt } : {}) },
    {
      garageId: payload.garageId ?? null,
      runAt: new Date(context.now().getTime() + delayMs),
      dedupeKey: `numbers.provision:continue:${context.job.id}`,
    },
  );
  return true;
}

export function createNumbersProvisionHandler(deps: NumbersProvisionDeps = {}): JobHandler {
  const clientFor = deps.client ?? ((env) => getTwilioNumbersClient(env));
  const repoFor = deps.repo ?? createSupabaseNumbersRepo;

  return async (payload, context) => {
    const input = parsePayload(numbersProvisionPayload, payload, context.job);
    const repo = repoFor(context.db);
    const config = readNumbersConfig(context.env);

    let client: TwilioNumbersClient | null = null;
    try {
      client = clientFor(context.env);
    } catch (error) {
      if (!isTwilioNumbersError(error) || error.kind !== "configuration_required") throw error;
      context.log.warn("numbers_not_configured");
    }

    const holder = context.job.id;
    if (!(await repo.claimLease(holder, NUMBERS_LEASE_SECONDS))) {
      const queued = await continueLater(context, input, BUSY_DELAY_MS, false);
      return { outcome: queued ? "busy_requeued" : "busy" };
    }

    let summary: ProvisionSummary;
    try {
      summary = await provisionNumbers({
        client,
        unconfiguredReason: client ? undefined : unconfiguredReason(context.env),
        repo,
        config,
        scope: input.garageId ? { kind: "garage", garageId: input.garageId } : { kind: "all" },
        canStartPurchase: () => context.deadline - context.clock() >= PURCHASE_MARGIN_MS,
        log: context.log,
      });
    } finally {
      await repo.releaseLease(holder).catch(() => undefined);
    }

    if (summary.stopped) {
      const { reason, retryAfterMs } = summary.stopped;
      const progressed = summary.bought + summary.attached > 0;
      const delay = reason === "deadline"
        ? 0
        : reason === "unconfirmed"
          ? UNCONFIRMED_DELAY_MS
          : Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, retryAfterMs ?? 0));
      const queued = await continueLater(context, input, delay, progressed && reason === "deadline");
      return { outcome: `stopped_${reason}${queued ? "_requeued" : ""}`, counts: counts(summary) };
    }
    return { outcome: summary.outcome, counts: { ...counts(summary), texting_ready: summary.texting === "ready" ? 1 : 0 } };
  };
}

export const numbersProvisionHandler = createNumbersProvisionHandler();
