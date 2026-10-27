import "server-only";

import { AskbridgeSyncError, runAskbridgeSync } from "@/lib/askbridge/sync";
import { askbridgeSyncPayload, parsePayload } from "../payloads";
import { permanentJobError, retryableJobError, type JobHandler } from "../types";

// `askbridge.sync` (P4.6): pushes one garage's knowledge (profile, services,
// hours, FAQs; never customer data) to Askbridge. Queued by the triggers in
// 20261028000600_domains_askbridge.sql at most once per garage per minute.
// runAskbridgeSync() decides what is retryable (network, 5xx, missing
// configuration) and what is not (bad payload, 4xx); skipped garages
// (gone, inactive, chat off) finish the job.

export function createAskbridgeSyncHandler(run: typeof runAskbridgeSync = runAskbridgeSync): JobHandler {
  return async (payload, context) => {
    const { garageId } = parsePayload(askbridgeSyncPayload, payload, context.job);
    try {
      const result = await run({ garageId }, { now: context.now(), env: context.env });
      context.log.info("askbridge.synced", { status: result.status, reason: result.status === "skipped" ? result.reason : undefined });
      return { outcome: result.status === "skipped" ? `skipped_${result.reason}` : result.status };
    } catch (error) {
      if (!(error instanceof AskbridgeSyncError)) throw error;
      // The messages are ours (no customer data or provider text), so they can go into jobs.last_error.
      throw error.retryable ? retryableJobError("ASKBRIDGE_SYNC_FAILED", error.message) : permanentJobError("ASKBRIDGE_SYNC_FAILED", error.message);
    }
  };
}

export const askbridgeSyncHandler = createAskbridgeSyncHandler();
