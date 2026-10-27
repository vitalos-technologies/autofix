import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDomainsClient, isDomainsError, type DomainsClient } from "@/lib/vercel/domains";
import { runDomainsCheck, type DomainsCheckRepo, type DomainToCheck, type GarageDomainStatus } from "@/lib/vercel/domains-check";
import { domainsCheckPayload, parsePayload } from "../payloads";
import { databaseError, type JobHandler } from "../types";

// `domains.check` (every 5 minutes on Vercel Pro; daily on Hobby): moves
// each custom garage domain one step through pending_dns -> verifying ->
// active (or failed after 48 hours) with runDomainsCheck() (P1.8). A Vercel
// rate limit queues the next check for when Vercel allows it; missing Vercel
// configuration is logged and the job ends (it cannot succeed on a retry).

const MAX_ROWS = 200;

type DomainRow = {
  id: string;
  garage_id: string;
  hostname: string;
  kind: "subdomain" | "custom";
  status: GarageDomainStatus;
  created_at: string;
  last_checked_at: string | null;
  verification: Record<string, unknown> | null;
};

/** `garage_domains` through the service role. Updates name the row's garage as well as its id. */
export function createSupabaseDomainsCheckRepo(db: SupabaseClient): DomainsCheckRepo {
  const garageOf = new Map<string, string>();
  return {
    async listDomainsToCheck() {
      const { data, error } = await db
        .from("garage_domains")
        .select("id,garage_id,hostname,kind,status,created_at,last_checked_at,verification")
        .eq("kind", "custom")
        .in("status", ["pending_dns", "verifying"])
        .is("deleted_at", null)
        .order("last_checked_at", { ascending: true, nullsFirst: true })
        .limit(MAX_ROWS);
      if (error) throw databaseError("garage_domains.list", error);
      return ((data ?? []) as DomainRow[]).map((row): DomainToCheck => {
        garageOf.set(row.id, row.garage_id);
        // "Try again" (P4.3) restarts the 48-hour window by writing verification.pending_since.
        const restarted = typeof row.verification?.pending_since === "string" ? row.verification.pending_since : null;
        return {
          id: row.id,
          hostname: row.hostname,
          garageId: row.garage_id,
          kind: row.kind,
          status: row.status,
          pendingSince: restarted ?? row.created_at,
          lastCheckedAt: row.last_checked_at,
        };
      });
    },
    async updateDomainStatus(id, patch) {
      let query = db
        .from("garage_domains")
        .update({ status: patch.status, error: patch.error, last_checked_at: patch.lastCheckedAt.toISOString() })
        .eq("id", id);
      const garageId = garageOf.get(id);
      if (garageId) query = query.eq("garage_id", garageId);
      const { error } = await query;
      if (error) throw databaseError("garage_domains.update", error);
    },
  };
}

export type DomainsCheckDeps = {
  client?: (env: Readonly<Record<string, string | undefined>>) => DomainsClient;
  repo?: (db: SupabaseClient) => DomainsCheckRepo;
};

export function createDomainsCheckHandler(deps: DomainsCheckDeps = {}): JobHandler {
  const clientFor = deps.client ?? ((env) => getDomainsClient(env));
  const repoFor = deps.repo ?? createSupabaseDomainsCheckRepo;

  return async (payload, context) => {
    parsePayload(domainsCheckPayload, payload, context.job);
    let client: DomainsClient;
    try {
      client = clientFor(context.env);
    } catch (error) {
      if (isDomainsError(error) && error.code === "configuration_required") {
        context.log.warn("domains_not_configured");
        return { outcome: "configuration_required" };
      }
      throw error;
    }

    const now = context.now();
    const summary = await runDomainsCheck({ repo: repoFor(context.db), client, now });
    const counts = {
      considered: summary.considered,
      checked: summary.checked,
      skipped: summary.skipped,
      errors: summary.errors.length,
      active: summary.outcomes.filter((outcome) => outcome.to === "active" && outcome.from !== "active").length,
      failed: summary.outcomes.filter((outcome) => outcome.to === "failed").length,
    };

    if (summary.stopped?.reason === "rate_limited") {
      await context.queue.enqueue("domains.check", {}, {
        runAt: new Date(now.getTime() + Math.max(1000, summary.stopped.retryAfterMs)),
        dedupeKey: `domains.check:retry:${context.job.id}`,
      });
      return { outcome: "rate_limited", counts };
    }
    if (summary.stopped) {
      context.log.warn("domains_check_stopped", { reason: summary.stopped.reason });
      return { outcome: summary.stopped.reason, counts };
    }
    return { outcome: "checked", counts };
  };
}

export const domainsCheckHandler = createDomainsCheckHandler();
