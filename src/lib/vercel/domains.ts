/**
 * Vercel domains adapter (P1.8): attach garage custom domains to the shared `autofix` project.
 *
 * Official Vercel docs read on 26 Oct 2026 (pages showed last_updated 2026-10-26 unless noted):
 * - Add a domain to a project, POST /v10/projects/{idOrName}/domains
 *   https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project
 *   ("If the domain already exists on the project, the request will fail with a 400 status code";
 *   409 when it is assigned to another project.)
 * - Get a project domain, GET /v9/projects/{idOrName}/domains/{domain}
 *   https://vercel.com/docs/rest-api/projects/get-a-project-domain
 * - Verify project domain, POST /v9/projects/{idOrName}/domains/{domain}/verify
 *   https://vercel.com/docs/rest-api/projects/verify-project-domain (400 when the TXT record is missing or wrong)
 * - Remove a domain from a project, DELETE /v9/projects/{idOrName}/domains/{domain}
 *   https://vercel.com/docs/rest-api/projects/remove-a-domain-from-a-project
 * - Get a domain's configuration, GET /v6/domains/{domain}/config (misconfigured, configuredBy, recommendedCNAME)
 *   https://vercel.com/docs/rest-api/domains/get-a-domain-s-configuration
 * - Error body `{ error: { code, message, limit?: { reset, resetMs } } }`: https://vercel.com/docs/rest-api/errors
 * - Rate limits (api-projects-domains-post 100/min, -verify 100/min, -get 500/min, api-domains-get-config 500/min;
 *   Hobby 50 domains per project): https://vercel.com/docs/limits (last_updated 2026-09-16)
 * - Multi-tenant flow and codes (domain_already_in_use, invalid_domain, forbidden, rate_limit_exceeded):
 *   https://vercel.com/docs/platforms/multi-tenant-platforms/reference (last_updated 2026-09-03)
 * All requests are scoped with `?teamId=`. Retry-After / X-RateLimit-Reset (epoch seconds) handling is from
 * general Vercel API knowledge; those headers were not on the pages above.
 *
 * The token lives only in the client closure: it is never logged, put in an error, or exposed on the object.
 */
import "server-only";

import { z } from "zod";
import { isPlatformHostname, normaliseHostname, registrableDomain } from "./hostname";

export {
  defaultPlatformDomains,
  isPlatformHostname,
  normaliseHostname,
  registrableDomain,
  validateGarageHostname,
  type HostnameRejection,
  type HostnameValidation,
} from "./hostname";

export const VERCEL_API_BASE_URL = "https://api.vercel.com";
export const DEFAULT_CNAME_TARGET = "cname.vercel-dns-0.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export type DomainsMode = "mock" | "live";

/** A DNS challenge the garage must add before Vercel will serve the domain for us. */
export type VerificationChallenge = {
  /** Usually `TXT`. */
  type: string;
  /** Full record name, e.g. `_vercel.theirgarage.co.uk`. */
  domain: string;
  value: string;
  reason: string;
};

export type ProjectDomain = {
  name: string;
  apexName: string;
  projectId: string | null;
  /** True once Vercel accepts the domain for this project (no ownership challenge outstanding). */
  verified: boolean;
  verification: VerificationChallenge[];
};

export type AddDomainResult = ProjectDomain & {
  /** True when the domain was already on this project (idempotent add). */
  alreadyExisted: boolean;
};

export type VerifyDomainResult = {
  name: string;
  verified: boolean;
  /** Why verification did not pass yet (e.g. TXT record missing), when Vercel said so. */
  reason: string | null;
};

export type DomainConfiguredBy = "A" | "CNAME" | "http" | "dns-01" | null;

export type DomainConfig = {
  /** True until DNS points at Vercel AND a certificate can be issued. */
  misconfigured: boolean;
  /** How Vercel sees the DNS (`CNAME`, `A`, `http` behind a proxy, `dns-01`), or null if not at all. */
  configuredBy: DomainConfiguredBy;
  /** Vercel's rank-1 recommended CNAME target, if any. */
  recommendedCname: string | null;
  recommendedIPv4: string[];
  acceptedChallenges: string[];
};

export type RemoveDomainResult = {
  /** False when the domain was not on the project (idempotent remove). */
  removed: boolean;
};

export interface DomainsClient {
  readonly mode: DomainsMode;
  addDomain(hostname: string): Promise<AddDomainResult>;
  getDomain(hostname: string): Promise<ProjectDomain>;
  getConfig(hostname: string): Promise<DomainConfig>;
  verifyDomain(hostname: string): Promise<VerifyDomainResult>;
  removeDomain(hostname: string): Promise<RemoveDomainResult>;
}

export type DomainsErrorCode =
  | "configuration_required"
  | "invalid_domain"
  | "domain_taken"
  | "not_found"
  | "rate_limited"
  | "forbidden"
  | "upstream_error";

export class DomainsError extends Error {
  override readonly name = "DomainsError";
  readonly code: DomainsErrorCode;
  /** HTTP status from Vercel, when there was a response. */
  readonly status: number | null;
  /** Vercel's own `error.code`, for diagnostics. */
  readonly vercelCode: string | null;
  /** Set for `rate_limited`: how long to wait before calling again. */
  readonly retryAfterMs: number | null;
  /** True for transient failures worth retrying later (rate limits, Vercel or network errors). */
  readonly retryable: boolean;

  constructor(
    code: DomainsErrorCode,
    message: string,
    options: { status?: number | null; vercelCode?: string | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status ?? null;
    this.vercelCode = options.vercelCode ?? null;
    this.retryAfterMs = code === "rate_limited" ? (options.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS) : null;
    this.retryable = code === "rate_limited" || code === "upstream_error";
  }
}

export function isDomainsError(error: unknown): error is DomainsError {
  return error instanceof DomainsError;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/**
 * Minimal syntax check before a hostname goes into a URL path. Full garage-facing validation is
 * `validateGarageHostname`; this only guarantees a plain DNS name (no slashes, dots-only tricks).
 */
function toApiHostname(hostname: string): string {
  const host = normaliseHostname(String(hostname ?? ""));
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes("..") || host.startsWith(".")) {
    throw new DomainsError("invalid_domain", "The domain is not a valid hostname.");
  }
  return host;
}

function assertNotPlatformHostname(host: string, action: "add" | "remove"): void {
  if (isPlatformHostname(host)) {
    throw new DomainsError("invalid_domain", `Refusing to ${action} a platform domain on the project.`);
  }
}

/** CNAME target shown to garages; `VERCEL_DOMAIN_CNAME_TARGET` overrides the Vercel default. */
export function getDomainCnameTarget(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.VERCEL_DOMAIN_CNAME_TARGET ? normaliseHostname(env.VERCEL_DOMAIN_CNAME_TARGET) : "";
  return configured || DEFAULT_CNAME_TARGET;
}

// ---------------------------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------------------------

const verificationSchema = z.object({
  type: z.string(),
  domain: z.string(),
  value: z.string(),
  reason: z.string().nullish(),
});

const projectDomainSchema = z.object({
  name: z.string(),
  apexName: z.string().nullish(),
  projectId: z.string().nullish(),
  verified: z.boolean(),
  verification: z.array(verificationSchema).nullish(),
});

const verifySchema = z.object({ name: z.string().nullish(), verified: z.boolean() });

const configSchema = z.object({
  misconfigured: z.boolean(),
  configuredBy: z.string().nullish(),
  recommendedCNAME: z.array(z.object({ rank: z.number(), value: z.string() })).nullish(),
  recommendedIPv4: z.array(z.object({ rank: z.number(), value: z.array(z.string()) })).nullish(),
  acceptedChallenges: z.array(z.string()).nullish(),
});

const vercelErrorSchema = z.object({
  error: z.object({
    code: z.string().nullish(),
    message: z.string().nullish(),
    domain: z.string().nullish(),
    limit: z.object({ reset: z.number().nullish(), resetMs: z.number().nullish() }).nullish(),
  }),
});

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainsError("upstream_error", `Unexpected ${what} response from Vercel.`);
  return result.data;
}

function toProjectDomain(body: unknown, hostname: string): ProjectDomain {
  const parsed = parseOrThrow(projectDomainSchema, body, "project domain");
  return {
    name: normaliseHostname(parsed.name || hostname),
    apexName: parsed.apexName || registrableDomain(hostname) || hostname,
    projectId: parsed.projectId ?? null,
    verified: parsed.verified,
    verification: (parsed.verification ?? []).map((challenge) => ({
      type: challenge.type.toUpperCase(),
      domain: normaliseHostname(challenge.domain),
      value: challenge.value,
      reason: challenge.reason ?? "",
    })),
  };
}

function toDomainConfig(body: unknown): DomainConfig {
  const parsed = parseOrThrow(configSchema, body, "domain configuration");
  const byRank = <T extends { rank: number }>(items: T[] | null | undefined) => [...(items ?? [])].sort((a, b) => a.rank - b.rank);
  const configuredBy = parsed.configuredBy;
  const cname = byRank(parsed.recommendedCNAME)[0]?.value;
  return {
    misconfigured: parsed.misconfigured,
    configuredBy: configuredBy === "A" || configuredBy === "CNAME" || configuredBy === "http" || configuredBy === "dns-01" ? configuredBy : null,
    recommendedCname: cname ? normaliseHostname(cname) : null,
    recommendedIPv4: byRank(parsed.recommendedIPv4)[0]?.value ?? [],
    acceptedChallenges: parsed.acceptedChallenges ?? [],
  };
}

type VercelErrorInfo = { code: string | null; message: string | null; domain: string | null; resetMs: number | null };

function readVercelError(body: unknown): VercelErrorInfo {
  const parsed = vercelErrorSchema.safeParse(body);
  if (!parsed.success) return { code: null, message: null, domain: null, resetMs: null };
  const { code, message, domain, limit } = parsed.data.error;
  const resetMs = limit?.resetMs ?? (limit?.reset ? limit.reset * 1000 : null);
  return { code: code ?? null, message: message ?? null, domain: domain ?? null, resetMs };
}

function retryAfterMs(headers: Headers, info: VercelErrorInfo, nowMs: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  if (info.resetMs) return Math.max(0, info.resetMs - nowMs);
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (reset > 0) return Math.max(0, reset * 1000 - nowMs);
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

// ---------------------------------------------------------------------------------------------
// Live Vercel client
// ---------------------------------------------------------------------------------------------

export type VercelDomainsClientOptions = {
  token: string;
  projectId: string;
  teamId?: string | null;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Extra attempts after a network error, timeout or 5xx (all calls here are idempotent). */
  retries?: number;
  retryBaseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Operation = "add" | "get" | "verify" | "config" | "remove";
type RawResponse = { status: number; headers: Headers; body: unknown };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createVercelDomainsClient(options: VercelDomainsClientOptions): DomainsClient {
  const token = options.token?.trim();
  const projectId = options.projectId?.trim();
  if (!token || !projectId) {
    throw new DomainsError("configuration_required", "Vercel domains need VERCEL_API_TOKEN and VERCEL_PROJECT_ID.");
  }
  const teamId = options.teamId?.trim() || null;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? VERCEL_API_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const project = encodeURIComponent(projectId);

  function buildUrl(path: string, query: Record<string, string> = {}): string {
    const url = new URL(`${baseUrl}${path}`);
    if (teamId) url.searchParams.set("teamId", teamId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  async function send(method: "GET" | "POST" | "DELETE", path: string, init: { query?: Record<string, string>; body?: unknown } = {}): Promise<RawResponse> {
    const url = buildUrl(path, init.query);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt += 1) {
      const canRetry = attempt < retries;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch (error) {
        if (canRetry) {
          await sleep(backoff(attempt));
          continue;
        }
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new DomainsError("upstream_error", timedOut ? "Vercel did not respond in time." : "Could not reach Vercel.");
      }

      if (response.status >= 500 && canRetry) {
        await sleep(backoff(attempt));
        continue;
      }
      return { status: response.status, headers: response.headers, body: await readJson(response) };
    }
  }

  function backoff(attempt: number): number {
    if (retryBaseDelayMs === 0) return 0;
    const base = retryBaseDelayMs * 2 ** attempt;
    return base + Math.floor(Math.random() * retryBaseDelayMs);
  }

  function toError(operation: Operation, response: RawResponse): DomainsError {
    const info = readVercelError(response.body);
    const { status } = response;
    const detail = info.message ? `: ${info.message}` : "";
    const meta = { status, vercelCode: info.code };
    const code = info.code ?? "";

    if (status === 429 || code === "rate_limited" || code === "rate_limit_exceeded") {
      return new DomainsError("rate_limited", "Vercel rate limit reached; try again later.", {
        ...meta,
        retryAfterMs: retryAfterMs(response.headers, info, now()),
      });
    }
    if (status === 401) {
      return new DomainsError("configuration_required", "Vercel rejected the API token. Check VERCEL_API_TOKEN.", meta);
    }
    if (status === 402) {
      return new DomainsError("forbidden", `The Vercel account needs a plan or payment change${detail}`, meta);
    }
    if (status === 403) {
      const domainOwnedElsewhere = operation === "add" && (Boolean(info.domain) || /access to the domain|access to "/i.test(info.message ?? ""));
      return domainOwnedElsewhere
        ? new DomainsError("domain_taken", `The domain belongs to another Vercel account or team${detail}`, meta)
        : new DomainsError("forbidden", `Vercel refused the request${detail}`, meta);
    }
    if (status === 404) {
      return operation === "add"
        ? new DomainsError("configuration_required", "Vercel project not found. Check VERCEL_PROJECT_ID and VERCEL_TEAM_ID.", meta)
        : new DomainsError("not_found", `Not found on Vercel${detail}`, meta);
    }
    if (status === 409 && operation === "add") {
      return new DomainsError("domain_taken", `The domain is already in use on another Vercel project${detail}`, meta);
    }
    if (status === 400 && isInvalidDomainError(info)) {
      return new DomainsError("invalid_domain", `Vercel says the domain is not valid${detail}`, meta);
    }
    if (status === 400 && operation === "add" && /already/i.test(`${info.message ?? ""} ${code}`)) {
      return new DomainsError("domain_taken", `The domain is already in use${detail}`, meta);
    }
    return new DomainsError("upstream_error", `Vercel returned ${status}${detail}`, meta);
  }

  async function getDomain(hostname: string): Promise<ProjectDomain> {
    const host = toApiHostname(hostname);
    const response = await send("GET", `/v9/projects/${project}/domains/${encodeURIComponent(host)}`);
    if (response.status === 200) return toProjectDomain(response.body, host);
    throw toError("get", response);
  }

  return {
    mode: "live",

    async addDomain(hostname) {
      const host = toApiHostname(hostname);
      assertNotPlatformHostname(host, "add");
      const response = await send("POST", `/v10/projects/${project}/domains`, { body: { name: host } });
      if (response.status === 200 || response.status === 201) {
        return { ...toProjectDomain(response.body, host), alreadyExisted: false };
      }

      const error = toError("add", response);
      // Idempotent add: Vercel answers 400 (already on this project) or 409 (in use elsewhere).
      // Ask our own project; if it is there, the earlier add (or a retried one) already succeeded.
      if ((response.status === 400 || response.status === 409) && error.code !== "invalid_domain") {
        try {
          const existing = await getDomain(host);
          return { ...existing, alreadyExisted: true };
        } catch (probeError) {
          if (!isDomainsError(probeError) || probeError.code !== "not_found") throw probeError;
        }
      }
      throw error;
    },

    getDomain,

    async getConfig(hostname) {
      const host = toApiHostname(hostname);
      const response = await send("GET", `/v6/domains/${encodeURIComponent(host)}/config`, { query: { projectIdOrName: projectId } });
      if (response.status === 200) return toDomainConfig(response.body);
      throw toError("config", response);
    },

    async verifyDomain(hostname) {
      const host = toApiHostname(hostname);
      const response = await send("POST", `/v9/projects/${project}/domains/${encodeURIComponent(host)}/verify`);
      if (response.status === 200) {
        const parsed = parseOrThrow(verifySchema, response.body, "verification");
        return { name: host, verified: parsed.verified, reason: null };
      }
      if (response.status === 400) {
        const info = readVercelError(response.body);
        if (/not assigned/i.test(info.message ?? "")) {
          throw new DomainsError("not_found", "The domain is not on the Vercel project.", { status: 400, vercelCode: info.code });
        }
        if (!/request (query|body) is invalid/i.test(info.message ?? "")) {
          // TXT record missing, wrong, or verifying another project: not verified yet, not a failure.
          return { name: host, verified: false, reason: info.message ?? "The verification record was not found." };
        }
      }
      throw toError("verify", response);
    },

    async removeDomain(hostname) {
      const host = toApiHostname(hostname);
      assertNotPlatformHostname(host, "remove");
      const response = await send("DELETE", `/v9/projects/${project}/domains/${encodeURIComponent(host)}`);
      if (response.status === 200 || response.status === 204) return { removed: true };
      if (response.status === 404) return { removed: false };
      throw toError("remove", response);
    },
  };
}

function isInvalidDomainError(info: VercelErrorInfo): boolean {
  if (info.code && ["invalid_domain", "invalid_name", "missing_name", "invalid_domain_name"].includes(info.code)) return true;
  return /domain is not valid|invalid domain|invalid_domain|not a valid domain/i.test(info.message ?? "");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Mock client (dev and tests)
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic in-memory stand-in for Vercel. Behaviour by hostname:
 * - contains `taken`: addDomain throws `domain_taken`.
 * - contains `ratelimit`: addDomain throws `rate_limited` (retry after 60 s).
 * - contains `pending`: needs a TXT ownership record that never verifies; DNS never configured.
 * - contains `fail`: verified, but DNS stays misconfigured (CNAME never found).
 * - anything else: verified on add; first config check sees the CNAME but no certificate yet
 *   (`verifying`), the second and later checks are fully configured (`active`).
 */
export type MockDomainsClient = DomainsClient & {
  readonly mode: "mock";
  /** Hostnames currently on the mock project. */
  list(): string[];
  reset(): void;
};

type MockDomainState = { domain: ProjectDomain; configChecks: number };

export function createMockDomainsClient(options: { projectId?: string; cnameTarget?: string } = {}): MockDomainsClient {
  const projectId = options.projectId ?? "prj_mock_autofix";
  const cnameTarget = options.cnameTarget ?? DEFAULT_CNAME_TARGET;
  const domains = new Map<string, MockDomainState>();

  const behaviour = (host: string) =>
    host.includes("taken") ? "taken" : host.includes("ratelimit") ? "ratelimit" : host.includes("pending") ? "pending" : host.includes("fail") ? "fail" : "normal";

  function copy(domain: ProjectDomain): ProjectDomain {
    return { ...domain, verification: domain.verification.map((challenge) => ({ ...challenge })) };
  }

  function find(hostname: string): MockDomainState {
    const state = domains.get(toApiHostname(hostname));
    if (!state) throw new DomainsError("not_found", "Not found on Vercel: domain is not on the project (mock).", { status: 404, vercelCode: "not_found" });
    return state;
  }

  return {
    mode: "mock",

    async addDomain(hostname) {
      const host = toApiHostname(hostname);
      assertNotPlatformHostname(host, "add");
      const existing = domains.get(host);
      if (existing) return { ...copy(existing.domain), alreadyExisted: true };

      const kind = behaviour(host);
      if (kind === "taken") throw new DomainsError("domain_taken", "The domain is already in use on another Vercel project (mock).", { status: 409, vercelCode: "domain_already_in_use" });
      if (kind === "ratelimit") throw new DomainsError("rate_limited", "Vercel rate limit reached; try again later (mock).", { status: 429, vercelCode: "rate_limited", retryAfterMs: 60_000 });

      const apexName = registrableDomain(host) ?? host;
      const domain: ProjectDomain = {
        name: host,
        apexName,
        projectId,
        verified: kind !== "pending",
        verification: kind === "pending"
          ? [{ type: "TXT", domain: `_vercel.${apexName}`, value: `vc-domain-verify=${host},${fnv1a(host)}`, reason: "pending_domain_verification" }]
          : [],
      };
      domains.set(host, { domain, configChecks: 0 });
      return { ...copy(domain), alreadyExisted: false };
    },

    async getDomain(hostname) {
      return copy(find(hostname).domain);
    },

    async getConfig(hostname) {
      const host = toApiHostname(hostname);
      const state = domains.get(host);
      const base = { recommendedCname: cnameTarget, recommendedIPv4: ["76.76.21.21"], acceptedChallenges: [] as string[] };
      const kind = behaviour(host);
      if (!state || kind === "pending" || kind === "fail") return { ...base, misconfigured: true, configuredBy: null };
      state.configChecks += 1;
      return state.configChecks === 1
        ? { ...base, misconfigured: true, configuredBy: "CNAME" }
        : { ...base, misconfigured: false, configuredBy: "CNAME", acceptedChallenges: ["http-01"] };
    },

    async verifyDomain(hostname) {
      const state = find(hostname);
      if (behaviour(state.domain.name) === "pending") {
        return { name: state.domain.name, verified: false, reason: "The domain does not have a TXT record that attempts to verify the project domain (mock)." };
      }
      state.domain.verified = true;
      state.domain.verification = [];
      return { name: state.domain.name, verified: true, reason: null };
    },

    async removeDomain(hostname) {
      const host = toApiHostname(hostname);
      assertNotPlatformHostname(host, "remove");
      return { removed: domains.delete(host) };
    },

    list() {
      return [...domains.keys()].sort();
    },

    reset() {
      domains.clear();
    },
  };
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

export type DomainsReadiness = {
  mode: DomainsMode | "invalid";
  /** `operational` (live with credentials), `mock`, or `configuration_required`. */
  status: "operational" | "mock" | "configuration_required";
  /** Names of missing or wrong variables. Never values. */
  missing: string[];
};

/** For `/api/health`: reports the domains integration state without revealing any value. */
export function getDomainsReadiness(env: Env = process.env): DomainsReadiness {
  const rawMode = (env.VERCEL_DOMAINS_MODE ?? "").trim().toLowerCase() || "mock";
  if (rawMode !== "mock" && rawMode !== "live") return { mode: "invalid", status: "configuration_required", missing: ["VERCEL_DOMAINS_MODE"] };
  if (rawMode === "live") {
    const missing = ["VERCEL_API_TOKEN", "VERCEL_PROJECT_ID"].filter((name) => !env[name]?.trim());
    return { mode: "live", status: missing.length ? "configuration_required" : "operational", missing };
  }
  // Fail closed: production must never pretend to connect garage domains.
  if (env.VERCEL_ENV === "production") return { mode: "mock", status: "configuration_required", missing: ["VERCEL_DOMAINS_MODE"] };
  return { mode: "mock", status: "mock", missing: [] };
}

const MOCK_SINGLETON = Symbol.for("autofix.vercel.mockDomainsClient");

function sharedMockClient(env: Env): MockDomainsClient {
  const store = globalThis as typeof globalThis & { [MOCK_SINGLETON]?: MockDomainsClient };
  store[MOCK_SINGLETON] ??= createMockDomainsClient({ cnameTarget: getDomainCnameTarget(env) });
  return store[MOCK_SINGLETON];
}

/**
 * The domains client for this environment.
 * - `VERCEL_DOMAINS_MODE=live` with `VERCEL_API_TOKEN` and `VERCEL_PROJECT_ID`: real Vercel client
 *   (`VERCEL_TEAM_ID` scopes it to the team).
 * - `live` without those: throws `configuration_required`.
 * - unset or `mock`: a shared in-memory mock, except on a production deployment, which fails closed.
 */
export function getDomainsClient(env: Env = process.env): DomainsClient {
  const readiness = getDomainsReadiness(env);
  if (readiness.status === "configuration_required") {
    const reason = readiness.mode === "invalid"
      ? "VERCEL_DOMAINS_MODE must be `live` or `mock`."
      : readiness.mode === "mock"
        ? "Production needs VERCEL_DOMAINS_MODE=live with Vercel credentials."
        : `Vercel domains live mode needs ${readiness.missing.join(" and ")}.`;
    throw new DomainsError("configuration_required", reason);
  }
  if (readiness.mode === "live") {
    return createVercelDomainsClient({
      token: env.VERCEL_API_TOKEN ?? "",
      projectId: env.VERCEL_PROJECT_ID ?? "",
      teamId: env.VERCEL_TEAM_ID,
    });
  }
  return sharedMockClient(env);
}
