/**
 * Client-safe shaping of a garage's custom domain for the Booking page settings (P4.3): the DNS
 * records to show (from `garage_domains.verification`), which status step failed, and what the
 * "Check now" button may do. The Vercel calls and writes live in `./domains-server.ts`.
 */
import type { DnsRecord } from "@/components/admin-ui/dns-record-table";
import type { GarageDomainStatus } from "@/lib/vercel/domains-check";

export type { GarageDomainStatus };

/** A record the garage adds at its DNS provider, as `startDomainConnection` describes it. */
export type StoredDnsRecord = {
  type: "CNAME" | "TXT";
  name: string;
  host: string;
  value: string;
  purpose: "routing" | "ownership";
};

/** What `garage_domains.verification` holds for a custom domain (written by the service role). */
export type StoredVerification = { records: StoredDnsRecord[]; pendingSince: string | null };

export type CustomDomainView = {
  id: string;
  hostname: string;
  status: GarageDomainStatus;
  error: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  records: StoredDnsRecord[];
  pendingSince: string;
};

const STATUSES = new Set<GarageDomainStatus>(["pending_dns", "verifying", "active", "failed"]);

export function isGarageDomainStatus(value: unknown): value is GarageDomainStatus {
  return typeof value === "string" && STATUSES.has(value as GarageDomainStatus);
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

/** `verification` jsonb → records and the start of the 48-hour window; anything malformed is dropped. */
export function parseStoredVerification(raw: unknown): StoredVerification {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const records = (Array.isArray(value.records) ? value.records : []).flatMap((entry): StoredDnsRecord[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const type = record.type === "CNAME" || record.type === "TXT" ? record.type : null;
    const name = text(record.name, 253);
    const host = text(record.host, 253);
    const recordValue = text(record.value, 1024);
    if (!type || !name || !host || !recordValue) return [];
    return [{ type, name, host, value: recordValue, purpose: type === "CNAME" ? "routing" : "ownership" }];
  });
  const pendingSince = typeof value.pendingSince === "string" && Number.isFinite(Date.parse(value.pendingSince)) ? value.pendingSince : null;
  return { records, pendingSince };
}

/**
 * The rows for `DnsRecordTable`: the CNAME first (it does the routing), then any ownership TXT.
 * When nothing was stored (a row added while Vercel was rate limited) the CNAME is still known.
 */
export function dnsRecordsForDisplay(domain: { hostname: string; records: StoredDnsRecord[] }, cnameTarget: string): DnsRecord[] {
  const records = domain.records.length
    ? domain.records
    : [{ type: "CNAME" as const, name: domain.hostname.split(".")[0] ?? domain.hostname, host: domain.hostname, value: cnameTarget, purpose: "routing" as const }];
  return [...records]
    .sort((a, b) => (a.type === b.type ? 0 : a.type === "CNAME" ? -1 : 1))
    .map((record) => ({ type: record.type, name: record.name, value: record.value }));
}

/** Which of the three steps a failure belongs to: HTTPS problems are step 2, DNS/ownership step 1. */
export function failedStepFor(error: string | null | undefined): 1 | 2 {
  return error && /HTTPS|certificate|CAA|proxy/i.test(error) ? 2 : 1;
}

/** Same as `DOMAIN_CHECK_INTERVAL_MS` in `@/lib/vercel/domains-check` (server-only; a test keeps them equal). */
export const DOMAIN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Milliseconds until "Check now" may ask Vercel again (0 = now). Matches `domains.check`'s throttle. */
export function checkAvailableInMs(lastCheckedAt: string | null, now: number = Date.now()): number {
  if (!lastCheckedAt) return 0;
  const last = Date.parse(lastCheckedAt);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + DOMAIN_CHECK_INTERVAL_MS - now);
}

/** True while the status can still move without the garage doing anything. */
export function isDomainInProgress(status: GarageDomainStatus) {
  return status === "pending_dns" || status === "verifying";
}
