// Shared HTTP plumbing for the accounting adapters: a request description that the contract tests
// compare with recorded fixtures, a fetch wrapper with a timeout, and the status → code mapping that
// every provider shares (429 → RATE_LIMITED with Retry-After, 401 → AUTH_EXPIRED, 5xx →
// PROVIDER_UNAVAILABLE). Provider bodies are never copied into errors.

import { AccountingError, parseRetryAfter, type AccountingErrorCode } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One provider request, built by a pure function (fixtures pin these shapes). */
export type ProviderRequest = {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  /** JSON body (object) or a form body (URLSearchParams string). */
  body?: unknown;
  form?: Record<string, string>;
};

export type ProviderResponse = { status: number; headers: Headers; body: unknown };

const TIMEOUT_MS = 12_000;

export function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

/** Sends a ProviderRequest. Network failures and timeouts become NETWORK. */
export async function send(fetcher: FetchLike, request: ProviderRequest): Promise<ProviderResponse> {
  const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
  let body: string | undefined;
  if (request.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.form).toString();
  } else if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.body);
  }
  let response: Response;
  try {
    response = await fetcher(request.url, { method: request.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new AccountingError("NETWORK", { detail: "request failed" });
  }
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/**
 * The common mapping. `validation` decides whether a 4xx body is a validation problem for this
 * provider (otherwise 400/422 still count as VALIDATION, 404 as NOT_FOUND).
 */
export function mapHttpError(response: ProviderResponse, now: Date = new Date()): AccountingError | null {
  const { status } = response;
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    return new AccountingError("RATE_LIMITED", { status, retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), now) ?? 60 });
  }
  let code: AccountingErrorCode;
  if (status === 401) code = "AUTH_EXPIRED";
  else if (status === 403) code = "AUTH_EXPIRED";
  else if (status === 404) code = "NOT_FOUND";
  else if (status === 400 || status === 409 || status === 422) code = "VALIDATION";
  else if (status >= 500) code = "PROVIDER_UNAVAILABLE";
  else code = "UNEXPECTED_RESPONSE";
  return new AccountingError(code, { status, detail: `HTTP ${status}` });
}

/** Throws the mapped error for a non-2xx response. */
export function ensureOk(response: ProviderResponse, now?: Date): ProviderResponse {
  const error = mapHttpError(response, now);
  if (error) throw error;
  return response;
}

/** Reads a string field or throws UNEXPECTED_RESPONSE (never echoes the body). */
export function requireString(value: unknown, what: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new AccountingError("UNEXPECTED_RESPONSE", { detail: `missing ${what}` });
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** OAuth token endpoint JSON → TokenSet fields (all three providers use RFC 6749 names). */
export function mapTokenResponse(body: unknown, now: Date, fallbackScopes: readonly string[]) {
  const record = asRecord(body);
  const accessToken = requireString(record.access_token, "access_token");
  const expiresIn = Number(record.expires_in ?? 1800);
  const refreshIn = record.x_refresh_token_expires_in ?? record.refresh_token_expires_in;
  const scope = typeof record.scope === "string" ? record.scope.split(/[\s,]+/).filter(Boolean) : [...fallbackScopes];
  return {
    accessToken,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : null,
    expiresAt: new Date(now.getTime() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000),
    refreshExpiresAt: refreshIn !== undefined && Number.isFinite(Number(refreshIn)) ? new Date(now.getTime() + Number(refreshIn) * 1000) : null,
    scopes: scope,
  };
}

/** A token endpoint failure: invalid_grant (and 400/401) means the user must reconnect. */
export function mapTokenError(response: ProviderResponse, now?: Date): AccountingError {
  const error = asRecord(response.body).error;
  if (response.status === 400 || response.status === 401 || error === "invalid_grant" || error === "invalid_client") {
    return new AccountingError("AUTH_EXPIRED", { status: response.status, detail: typeof error === "string" && /^[a-z_]{1,40}$/.test(error) ? error : "token refused" });
  }
  return mapHttpError(response, now) ?? new AccountingError("UNEXPECTED_RESPONSE", { status: response.status });
}
