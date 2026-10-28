import "server-only";

import type { JobHandler } from "@/lib/jobs/types";
import { releaseExpiredDeposits } from "./server";

/**
 * Job kind `payments.expire_deposits` (P5.4): expires pending payments past `expires_at`. An unpaid
 * deposit cancels its booking ("Deposit not paid in time") if it is still requested or confirmed,
 * which frees the slot, and the provider's open checkout is closed. Platform job, no payload,
 * idempotent; queued by the `daily` cron and by `/api/cron/payments.expire_deposits` (every 5 minutes
 * where a scheduler allows). The booking flow and the admin also release a garage's expired deposits
 * before they show times, so a slot is never held longer than its hold because a cron is slow.
 */
export const paymentsExpireDepositsHandler: JobHandler = async (_payload, context) => {
  const expired = await releaseExpiredDeposits(null, context.now(), context.db);
  context.log.info("payments.deposits_expired", { expired });
  return { outcome: expired ? "expired" : "none", counts: { expired } };
};
