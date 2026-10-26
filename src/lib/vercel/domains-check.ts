/**
 * `domains.check` job logic and the garage domain connect/remove flows (P1.8, SPEC "Garage domain flow").
 *
 * Independent of the job queue: P3.7 registers `runDomainsCheck` as the `domains.check` job and
 * supplies a Supabase-backed `DomainsCheckRepo`. Vercel endpoints and limits are documented in
 * `./domains.ts` (docs read 26 Oct 2026).
 *
 * Status machine for `garage_domains.status` (custom domains only; free `<slug>` subdomains are
 * covered by the wildcard and never checked here):
 *
 *   pending_dns --(Vercel sees DNS pointing at it)--> verifying --(verified + not misconfigured)--> active
 *        \__________________________ 48 h without reaching active __________________________/--> failed
 *
 * Each run checks a row at most once every 5 minutes (`last_checked_at`), checks the row first and
 * only then applies the 48-hour cut-off (so a domain fixed in the last minutes still goes live),
 * and stops the whole batch on `rate_limited`, `configuration_required` or `forbidden`.
 */
import "server-only";

import {
  DomainsError,
  getDomainCnameTarget,
  getDomainsClient,
  isDomainsError,
  type DomainConfig,
  type DomainsClient,
  type DomainsErrorCode,
  type ProjectDomain,
} from "./domains";
import { isPlatformHostname, normaliseHostname, validateGarageHostname } from "./hostname";

export const DOMAIN_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const DOMAIN_CHECK_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Each row costs up to four Vercel calls; 25 rows stays far below the per-minute limits. */
export const DEFAULT_DOMAINS_CHECK_BATCH_SIZE = 25;

export type GarageDomainStatus = "pending_dns" | "verifying" | "active" | "failed";

export type DomainToCheck = {
  id: string;
  hostname: string;
  garageId?: string;
  /** `subdomain` rows (free link) are skipped. */
  kind?: "subdomain" | "custom";
  status: GarageDomainStatus;
  /** Start of the current 48-hour window: `created_at`, or when the garage last pressed "Try again". */
  pendingSince: Date | string;
  lastCheckedAt: Date | string | null;
};

export type DomainStatusPatch = {
  status: GarageDomainStatus;
  /** Garage-facing reason, set only when `status` is `failed`. */
  error: string | null;
  lastCheckedAt: Date;
};

export interface DomainsCheckRepo {
  /** Custom domains in `pending_dns` or `verifying`, ideally oldest `last_checked_at` first (nulls first). */
  listDomainsToCheck(now: Date): Promise<DomainToCheck[]>;
  updateDomainStatus(id: string, patch: DomainStatusPatch): Promise<void>;
}

export type DomainCheckOutcome = {
  id: string;
  hostname: string;
  garageId?: string;
  from: GarageDomainStatus;
  to: GarageDomainStatus;
  error: string | null;
};

export type DomainCheckFailure = {
  id: string;
  hostname: string;
  garageId?: string;
  code: DomainsErrorCode | "unexpected";
  message: string;
};

export type DomainsCheckStop =
  | { reason: "rate_limited"; retryAfterMs: number }
  | { reason: "configuration_required" | "forbidden"; message: string };

export type DomainsCheckSummary = {
  /** Rows returned by the repo. */
  considered: number;
  /** Rows with a decided outcome written back. */
  checked: number;
  /** Rows not due (checked < 5 minutes ago), not checkable, beyond the batch size, or left after a stop. */
  skipped: number;
  outcomes: DomainCheckOutcome[];
  /** Rows that hit a transient error; `last_checked_at` was still bumped so they back off 5 minutes. */
  errors: DomainCheckFailure[];
  /** Set when the batch stopped early; the job runner should back off accordingly. */
  stopped: DomainsCheckStop | null;
};

export type RunDomainsCheckInput = {
  repo: DomainsCheckRepo;
  client: DomainsClient;
  now?: Date;
  batchSize?: number;
  cnameTarget?: string;
};

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isCheckable(row: DomainToCheck): boolean {
  return row.kind !== "subdomain" && (row.status === "pending_dns" || row.status === "verifying");
}

function isDue(row: DomainToCheck, nowMs: number): boolean {
  const last = toMs(row.lastCheckedAt);
  return last === null || nowMs - last >= DOMAIN_CHECK_INTERVAL_MS;
}

/** Decide the next status from what Vercel reports. Exported for tests and the admin UI. */
export function nextDomainStatus(input: { verified: boolean; config: DomainConfig }): Exclude<GarageDomainStatus, "failed"> {
  if (input.verified && !input.config.misconfigured) return "active";
  const dnsSeen = input.config.configuredBy !== null || !input.config.misconfigured;
  return dnsSeen ? "verifying" : "pending_dns";
}

function failureMessage(hostname: string, state: { verified: boolean; config: DomainConfig; domain: ProjectDomain }, cnameTarget: string): string {
  const txt = state.domain.verification.find((challenge) => challenge.type === "TXT");
  if (!state.verified && txt) {
    return `We couldn't confirm that you own ${hostname}. Add the TXT record ${txt.domain} with the value shown on this page at your domain provider, then try again.`;
  }
  if (state.config.configuredBy === null) {
    return `We couldn't find a CNAME record for ${hostname} pointing to ${cnameTarget} after 48 hours. Check the record at your domain provider, then try again.`;
  }
  return `${hostname} points to us, but we couldn't secure it with HTTPS after 48 hours. Turn off any proxy in front of it (such as Cloudflare's orange cloud) and remove CAA records that block Let's Encrypt, then try again.`;
}

function takenMessage(hostname: string): string {
  return `${hostname} is already connected to another website on our hosting provider. Remove it there, then try again.`;
}

type RowResult = { patch: DomainStatusPatch };

async function checkOne(row: DomainToCheck, client: DomainsClient, now: Date, cnameTarget: string): Promise<RowResult> {
  const failed = (error: string): RowResult => ({ patch: { status: "failed", error, lastCheckedAt: now } });

  const validation = validateGarageHostname(row.hostname);
  if (!validation.ok) return failed(validation.message);
  const hostname = validation.hostname;

  // 1. The domain must be on the project. Self-heal rows whose add was queued or rate limited.
  let domain: ProjectDomain;
  try {
    domain = await client.getDomain(hostname);
  } catch (error) {
    if (!isDomainsError(error) || error.code !== "not_found") throw error;
    try {
      domain = await client.addDomain(hostname);
    } catch (addError) {
      if (isDomainsError(addError) && addError.code === "domain_taken") return failed(takenMessage(hostname));
      if (isDomainsError(addError) && addError.code === "invalid_domain") return failed(`${hostname} isn't a web address we can connect. Check the spelling, then try again.`);
      throw addError;
    }
  }

  // 2. Ownership: ask Vercel to re-check the TXT challenge when one is outstanding.
  let verified = domain.verified;
  if (!verified) verified = (await client.verifyDomain(hostname)).verified;

  // 3. DNS and certificate.
  const config = await client.getConfig(hostname);
  const next = nextDomainStatus({ verified, config });
  if (next === "active") return { patch: { status: "active", error: null, lastCheckedAt: now } };

  // 4. Out of time: fail with a reason the garage can act on.
  const startedMs = toMs(row.pendingSince) ?? now.getTime();
  if (now.getTime() - startedMs >= DOMAIN_CHECK_WINDOW_MS) return failed(failureMessage(hostname, { verified, config, domain }, cnameTarget));

  return { patch: { status: next, error: null, lastCheckedAt: now } };
}

/** The `domains.check` job: advance every due custom domain one step. */
export async function runDomainsCheck(input: RunDomainsCheckInput): Promise<DomainsCheckSummary> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const batchSize = Math.max(1, input.batchSize ?? DEFAULT_DOMAINS_CHECK_BATCH_SIZE);
  const cnameTarget = input.cnameTarget ?? getDomainCnameTarget();

  const rows = await input.repo.listDomainsToCheck(now);
  const due = rows
    .filter((row) => isCheckable(row) && isDue(row, nowMs))
    .sort((a, b) => (toMs(a.lastCheckedAt) ?? -Infinity) - (toMs(b.lastCheckedAt) ?? -Infinity))
    .slice(0, batchSize);

  const summary: DomainsCheckSummary = { considered: rows.length, checked: 0, skipped: rows.length - due.length, outcomes: [], errors: [], stopped: null };

  for (const [index, row] of due.entries()) {
    let result: RowResult;
    try {
      result = await checkOne(row, input.client, now, cnameTarget);
    } catch (error) {
      if (isDomainsError(error) && error.code === "rate_limited") {
        summary.stopped = { reason: "rate_limited", retryAfterMs: error.retryAfterMs ?? 60_000 };
      } else if (isDomainsError(error) && (error.code === "configuration_required" || error.code === "forbidden")) {
        summary.stopped = { reason: error.code, message: error.message };
      }
      if (summary.stopped) {
        summary.skipped += due.length - index;
        break;
      }
      // Transient (Vercel 5xx, timeout) or unexpected: keep the status, back off 5 minutes, carry on.
      summary.errors.push({
        id: row.id,
        hostname: row.hostname,
        garageId: row.garageId,
        code: isDomainsError(error) ? error.code : "unexpected",
        message: error instanceof Error ? error.message : "Unexpected error",
      });
      await input.repo.updateDomainStatus(row.id, { status: row.status, error: null, lastCheckedAt: now });
      continue;
    }

    await input.repo.updateDomainStatus(row.id, result.patch);
    summary.checked += 1;
    summary.outcomes.push({ id: row.id, hostname: row.hostname, garageId: row.garageId, from: row.status, to: result.patch.status, error: result.patch.error });
  }

  return summary;
}

// ---------------------------------------------------------------------------------------------
// Connect and remove (called from the admin domain settings, P4.3)
// ---------------------------------------------------------------------------------------------

export type DnsRecordInstruction = {
  type: "CNAME" | "TXT";
  /** Name relative to the garage's domain, as most DNS panels want it (e.g. `book`, `_vercel`). */
  name: string;
  /** Full record name, e.g. `book.theirgarage.co.uk`. */
  host: string;
  value: string;
  purpose: "routing" | "ownership";
};

export type DomainConnection = {
  hostname: string;
  apexName: string;
  /** The row starts here; `domains.check` moves it on. */
  status: "pending_dns";
  verified: boolean;
  alreadyExisted: boolean;
  records: DnsRecordInstruction[];
};

export type DomainConnectionDeps = { client?: DomainsClient; cnameTarget?: string };

function relativeName(fqdn: string, apexName: string): string {
  const host = normaliseHostname(fqdn);
  if (host === apexName) return "@";
  return host.endsWith(`.${apexName}`) ? host.slice(0, -(apexName.length + 1)) : host;
}

/**
 * Validate the garage's hostname, add it to the Vercel project (idempotent) and return the DNS
 * records to show. Throws `DomainsError` (`invalid_domain`, `domain_taken`, `rate_limited`, ...).
 * On `rate_limited` the caller can still store the row as `pending_dns`: `domains.check` adds it later.
 */
export async function startDomainConnection(hostname: string, deps: DomainConnectionDeps = {}): Promise<DomainConnection> {
  const validation = validateGarageHostname(hostname);
  if (!validation.ok) throw new DomainsError("invalid_domain", validation.message);

  const client = deps.client ?? getDomainsClient();
  const cnameTarget = deps.cnameTarget ?? getDomainCnameTarget();
  const added = await client.addDomain(validation.hostname);

  const records: DnsRecordInstruction[] = [
    { type: "CNAME", name: validation.subdomain, host: validation.hostname, value: cnameTarget, purpose: "routing" },
    ...added.verification
      .filter((challenge) => challenge.type === "TXT")
      .map((challenge): DnsRecordInstruction => ({
        type: "TXT",
        name: relativeName(challenge.domain, validation.apexName),
        host: challenge.domain,
        value: challenge.value,
        purpose: "ownership",
      })),
  ];

  return {
    hostname: validation.hostname,
    apexName: validation.apexName,
    status: "pending_dns",
    verified: added.verified,
    alreadyExisted: added.alreadyExisted,
    records,
  };
}

/** Detach a garage domain from the Vercel project. Idempotent; refuses platform domains. */
export async function removeDomainConnection(hostname: string, deps: Pick<DomainConnectionDeps, "client"> = {}): Promise<{ hostname: string; removed: boolean }> {
  const host = normaliseHostname(hostname);
  if (!host || isPlatformHostname(host)) throw new DomainsError("invalid_domain", "That domain can't be removed here.");
  const client = deps.client ?? getDomainsClient();
  const { removed } = await client.removeDomain(host);
  return { hostname: host, removed };
}
