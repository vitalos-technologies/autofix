import "server-only";

import type { JobHandler } from "@/lib/jobs/types";

/**
 * Job kind `platform.close_impersonations` (P4.5): closes support sessions that
 * have expired, so each gets its "expired" entry in the garage's audit log even
 * when the admin never comes back. Expired sessions already admit nothing (the
 * database checks expires_at on every read); this only completes the record.
 * Service role, no payload, idempotent. Registered in src/lib/jobs (hourly
 * period; also queued by the `daily` cron).
 */
export const platformCloseImpersonationsHandler: JobHandler = async (_payload, context) => {
  const { data, error } = await context.db.rpc("close_expired_impersonations");
  if (error) throw new Error(`CLOSE_IMPERSONATIONS_FAILED: ${error.code ?? "unknown"}`);
  const closed = typeof data === "number" ? data : 0;
  context.log.info("platform.impersonations_closed", { closed });
  return { outcome: closed ? "closed" : "none", counts: { closed } };
};
