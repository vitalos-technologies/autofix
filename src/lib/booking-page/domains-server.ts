import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { clearHostCache } from "@/lib/tenancy/resolve";
import { getDomainCnameTarget, getDomainsClient, isDomainsError, type DomainsClient } from "@/lib/vercel/domains";
import {
  DOMAIN_CHECK_INTERVAL_MS,
  removeDomainConnection,
  runDomainsCheck,
  startDomainConnection,
  type DnsRecordInstruction,
  type DomainsCheckRepo,
  type DomainToCheck,
} from "@/lib/vercel/domains-check";
import { validateGarageHostname } from "@/lib/vercel/hostname";
import { isGarageDomainStatus, parseStoredVerification, type CustomDomainView, type GarageDomainStatus } from "./domain-view";

// Booking page settings (P4.3) on top of the P1.8 engine. Who may do what is decided by the caller
// (owners only); the RLS client adds and retires the garage's own row, and the service role, always
// filtered by `garage_id`, writes what staff have no grant for (`verification`, `status`).

const DOMAIN_COLUMNS = "id, hostname, status, error, last_checked_at, created_at, verification";

type DomainRow = {
  id: string;
  hostname: string;
  status: string;
  error: string | null;
  last_checked_at: string | null;
  created_at: string;
  verification: unknown;
};

export type DomainDeps = {
  /** The member's RLS client (sends the selected garage as `x-garage-id`). */
  rls: SupabaseClient;
  /** Service-role client; every statement names the garage. */
  service: SupabaseClient;
  domains?: DomainsClient;
  cnameTarget?: string;
  now?: Date;
};

function viewFromRow(row: DomainRow): CustomDomainView {
  const verification = parseStoredVerification(row.verification);
  return {
    id: row.id,
    hostname: row.hostname,
    status: isGarageDomainStatus(row.status) ? row.status : "pending_dns",
    error: row.error,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    records: verification.records,
    pendingSince: verification.pendingSince ?? row.created_at,
  };
}

/** The garage's current custom domain (at most one is live at a time), or null. */
export async function getCustomDomain(client: SupabaseClient, garageId: string): Promise<CustomDomainView | null> {
  const { data, error } = await client
    .from("garage_domains")
    .select(DOMAIN_COLUMNS)
    .eq("garage_id", garageId)
    .eq("kind", "custom")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`domain read failed: ${error.code ?? "unknown"}`);
  return data ? viewFromRow(data as DomainRow) : null;
}

export type ConnectResult =
  | { ok: true; domain: CustomDomainView; queued: boolean }
  | { ok: false; code: "invalid" | "already_connected" | "taken" | "unavailable" | "configuration_required"; message: string };

function relativeName(hostname: string, apexName: string) {
  return hostname === apexName ? "@" : hostname.slice(0, -(apexName.length + 1));
}

/**
 * Connect `book.theirgarage.co.uk`: validate, refuse a hostname another garage holds, add it to the
 * Vercel project, store the row (`pending_dns`) and the records to show. A Vercel rate limit still
 * stores the row with the CNAME: `domains.check` adds the domain to Vercel on its next run.
 */
export async function connectCustomDomain(garageId: string, input: string, deps: DomainDeps): Promise<ConnectResult> {
  const validation = validateGarageHostname(input);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.message };
  const hostname = validation.hostname;

  if (await getCustomDomain(deps.service, garageId)) {
    return { ok: false, code: "already_connected", message: "Your garage already has an address connected. Remove it first to connect a different one." };
  }
  const { data: claimed, error: claimError } = await deps.service.from("garage_domains").select("id").eq("hostname", hostname).is("deleted_at", null).limit(1);
  if (claimError) return { ok: false, code: "unavailable", message: "We couldn't check that address just now. Try again in a minute." };
  if (claimed?.length) return { ok: false, code: "taken", message: `${hostname} is already connected to another garage on Autofix.` };

  const cnameTarget = deps.cnameTarget ?? getDomainCnameTarget();
  let records: DnsRecordInstruction[];
  let queued = false;
  try {
    records = (await startDomainConnection(hostname, { client: deps.domains ?? getDomainsClient(), cnameTarget })).records;
  } catch (error) {
    if (!isDomainsError(error)) throw error;
    if (error.code === "rate_limited") {
      queued = true;
      records = [{ type: "CNAME", name: relativeName(hostname, validation.apexName), host: hostname, value: cnameTarget, purpose: "routing" }];
    } else if (error.code === "invalid_domain") {
      return { ok: false, code: "invalid", message: `${hostname} isn't a web address we can connect. Check the spelling, then try again.` };
    } else if (error.code === "domain_taken") {
      return { ok: false, code: "taken", message: `${hostname} is already connected to another website on our hosting provider. Remove it there, then try again.` };
    } else if (error.code === "configuration_required") {
      return { ok: false, code: "configuration_required", message: "Custom addresses aren't switched on yet. Your free link keeps working; try again later." };
    } else {
      return { ok: false, code: "unavailable", message: "We couldn't reach our hosting provider. Try again in a few minutes." };
    }
  }

  const now = deps.now ?? new Date();
  const inserted = await deps.rls.from("garage_domains").insert({ garage_id: garageId, hostname }).select("id").single();
  if (inserted.error || !inserted.data) {
    if (inserted.error?.code === "23505") return { ok: false, code: "taken", message: `${hostname} is already connected to another garage on Autofix.` };
    if (inserted.error?.code === "42501") return { ok: false, code: "unavailable", message: "You don't have permission to change this." };
    return { ok: false, code: "unavailable", message: "That address could not be saved. Try again." };
  }
  const id = (inserted.data as { id: string }).id;
  const { data, error } = await deps.service
    .from("garage_domains")
    .update({ verification: { records, pending_since: now.toISOString() } })
    .eq("garage_id", garageId)
    .eq("id", id)
    .select(DOMAIN_COLUMNS)
    .single();
  if (error || !data) return { ok: false, code: "unavailable", message: "That address was saved but its records could not be. Reload the page." };
  return { ok: true, domain: viewFromRow(data as DomainRow), queued };
}

/** `domains.check` repo backed by Supabase (service role). `scope` narrows it to one garage or one row. */
export function createSupabaseDomainsCheckRepo(client: SupabaseClient, scope: { garageId?: string; id?: string; limit?: number } = {}): DomainsCheckRepo {
  const hostnames = new Map<string, { hostname: string; garageId: string }>();
  return {
    async listDomainsToCheck() {
      let query = client
        .from("garage_domains")
        .select("id, garage_id, hostname, kind, status, created_at, last_checked_at, verification")
        .eq("kind", "custom")
        .in("status", ["pending_dns", "verifying"])
        .is("deleted_at", null);
      if (scope.garageId) query = query.eq("garage_id", scope.garageId);
      if (scope.id) query = query.eq("id", scope.id);
      const { data, error } = await query.order("last_checked_at", { ascending: true, nullsFirst: true }).limit(scope.limit ?? 100);
      if (error) throw new Error(`domains list failed: ${error.code ?? "unknown"}`);
      return ((data ?? []) as Array<DomainRow & { garage_id: string; kind: "custom" }>).map((row): DomainToCheck => {
        hostnames.set(row.id, { hostname: row.hostname, garageId: row.garage_id });
        return {
          id: row.id,
          hostname: row.hostname,
          garageId: row.garage_id,
          kind: row.kind,
          status: row.status as GarageDomainStatus,
          pendingSince: parseStoredVerification(row.verification).pendingSince ?? row.created_at,
          lastCheckedAt: row.last_checked_at,
        };
      });
    },
    async updateDomainStatus(id, patch) {
      const known = hostnames.get(id);
      let update = client
        .from("garage_domains")
        .update({ status: patch.status, error: patch.error, last_checked_at: patch.lastCheckedAt.toISOString() })
        .eq("id", id);
      if (known) update = update.eq("garage_id", known.garageId);
      const { error } = await update;
      if (error) throw new Error(`domain update failed: ${error.code ?? "unknown"}`);
      // A host that just went live (or stopped) must not wait for the 60 s cache.
      if (known) clearHostCache({ hostnames: [known.hostname] });
    },
  };
}

export type CheckNowResult =
  | { ok: true; domain: CustomDomainView; changed: boolean }
  | { ok: false; code: "none" | "not_checkable" | "throttled" | "busy" | "unavailable"; message: string; retryInMs?: number };

function minutes(ms: number) {
  const value = Math.max(1, Math.ceil(ms / 60_000));
  return `${value} minute${value === 1 ? "" : "s"}`;
}

/**
 * "Check now": the same single-row check `domains.check` runs, under the same 5-minute throttle.
 */
export async function checkCustomDomainNow(garageId: string, deps: Omit<DomainDeps, "rls">): Promise<CheckNowResult> {
  const now = deps.now ?? new Date();
  const current = await getCustomDomain(deps.service, garageId);
  if (!current) return { ok: false, code: "none", message: "There is no address to check." };
  if (current.status !== "pending_dns" && current.status !== "verifying") {
    return { ok: false, code: "not_checkable", message: current.status === "active" ? `${current.hostname} is already live.` : "Press Try again to check this address again." };
  }
  const last = current.lastCheckedAt ? Date.parse(current.lastCheckedAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < DOMAIN_CHECK_INTERVAL_MS) {
    const retryInMs = last + DOMAIN_CHECK_INTERVAL_MS - now.getTime();
    return { ok: false, code: "throttled", retryInMs, message: `We checked a moment ago. You can check again in ${minutes(retryInMs)}; we also keep checking on our own.` };
  }

  const summary = await runDomainsCheck({
    repo: createSupabaseDomainsCheckRepo(deps.service, { garageId, id: current.id }),
    client: deps.domains ?? getDomainsClient(),
    cnameTarget: deps.cnameTarget,
    now,
    batchSize: 1,
  });
  if (summary.stopped) {
    return { ok: false, code: "busy", message: summary.stopped.reason === "rate_limited" ? "Our hosting provider asked us to slow down. We'll keep checking on our own." : "Custom addresses aren't switched on yet. Your free link keeps working." };
  }
  if (summary.errors.length) return { ok: false, code: "unavailable", message: "We couldn't reach our hosting provider. We'll keep checking on our own." };
  const domain = await getCustomDomain(deps.service, garageId);
  if (!domain) return { ok: false, code: "none", message: "There is no address to check." };
  return { ok: true, domain, changed: domain.status !== current.status };
}

/** "Try again" after `failed`: a fresh 48-hour window, then an immediate check. */
export async function retryCustomDomain(garageId: string, deps: Omit<DomainDeps, "rls">): Promise<CheckNowResult> {
  const now = deps.now ?? new Date();
  const current = await getCustomDomain(deps.service, garageId);
  if (!current) return { ok: false, code: "none", message: "There is no address to check." };
  if (current.status !== "failed") return checkCustomDomainNow(garageId, deps);
  const { error } = await deps.service
    .from("garage_domains")
    .update({ status: "pending_dns", error: null, last_checked_at: null, verification: { records: current.records, pending_since: now.toISOString() } })
    .eq("garage_id", garageId)
    .eq("id", current.id);
  if (error) return { ok: false, code: "unavailable", message: "That could not be saved. Try again." };
  return checkCustomDomainNow(garageId, deps);
}

export type RemoveResult = { ok: true; hostname: string; detached: boolean } | { ok: false; code: "none" | "unavailable"; message: string };

/**
 * Stop using the custom address: retire the row (RLS: own garage, custom rows only) so the host stops
 * resolving at once, then detach it from Vercel (best effort; idempotent, safe to repeat).
 */
export async function removeCustomDomain(garageId: string, deps: DomainDeps): Promise<RemoveResult> {
  const current = await getCustomDomain(deps.rls, garageId);
  if (!current) return { ok: false, code: "none", message: "There is no address to remove." };
  const now = deps.now ?? new Date();
  const { data, error } = await deps.rls
    .from("garage_domains")
    .update({ deleted_at: now.toISOString() })
    .eq("garage_id", garageId)
    .eq("id", current.id)
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, code: "unavailable", message: error?.code === "42501" ? "You don't have permission to change this." : "That address could not be removed. Try again." };
  clearHostCache({ hostnames: [current.hostname] });
  let detached = false;
  try {
    detached = (await removeDomainConnection(current.hostname, { client: deps.domains ?? getDomainsClient() })).removed;
  } catch {
    // The row is retired, so the host no longer serves; a stale project domain is harmless.
  }
  return { ok: true, hostname: current.hostname, detached };
}
