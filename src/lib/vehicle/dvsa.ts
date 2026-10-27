import "server-only";

// DVSA MOT History API client (the current v1 "trade" API).
//
// Docs read 26 Oct 2026:
// - Overview: https://documentation.history.mot.api.gov.uk/mot-history-api/api-specification/
// - OpenAPI 3.0 (v1.0.0): https://documentation.history.mot.api.gov.uk/mot-history-api/api-specification/mot_history_open_api_specification.yml
// - Authentication: https://documentation.history.mot.api.gov.uk/mot-history-api/authentication/
// - Error codes: https://documentation.history.mot.api.gov.uk/mot-history-api/error-codes/
// - Rate limits: https://documentation.history.mot.api.gov.uk/mot-history-api/rate-limits/
// - Version history: https://documentation.history.mot.api.gov.uk/mot-history-api/version-history/
//   (v1.0 "MOT history for all vehicle types" is current; the old v6/v7 APIs are retired.)
//
// Auth: OAuth2 client credentials against Microsoft Entra. POST
// application/x-www-form-urlencoded to the token URL from the credentials email
// (https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token) with
// grant_type=client_credentials, client_id, client_secret and
// scope=https://tapi.dvsa.gov.uk/.default. Response {token_type: "Bearer",
// expires_in, ext_expires_in, access_token}. The docs say tokens last 60 minutes
// but their example shows expires_in 1199, so we trust expires_in and refresh a
// minute early. The docs ask clients to cache the token; we keep it in memory
// and share one in-flight request.
//
// Lookup: GET https://history.mot.api.gov.uk/v1/trade/vehicles/registration/{registration}
// with `Authorization: Bearer {token}` and `X-API-Key: {key}`. 200 is one of:
// - VehicleWithMotResponse: registration, make, model, firstUsedDate, fuelType,
//   primaryColour, registrationDate, manufactureDate, engineSize (string, cc),
//   hasOutstandingRecall, motTests[] of {registrationAtTimeOfTest, completedDate
//   (date-time), testResult PASSED|FAILED, expiryDate (date), odometerValue
//   (string), odometerUnit MI|KM|null, odometerResultType READ|UNREADABLE|NO_ODOMETER,
//   motTestNumber, dataSource DVSA|DVA NI|CVS, defects[] of {text, type
//   ADVISORY|DANGEROUS|FAIL|MAJOR|MINOR|NON SPECIFIC|SYSTEM GENERATED|USER ENTERED,
//   dangerous}}.
// - NewRegVehicleResponse (too new for an MOT): registration, make, model,
//   manufactureYear, fuelType, primaryColour, registrationDate, manufactureDate,
//   motTestDueDate, hasOutstandingRecall. No motTests.
// Errors {errorCode, errorMessage, requestId}: 400 MOTH-BR-01 / MOTH-IV-03 /
// MOTH-NP-02, 401 MOTH-UA-01, 403 MOTH-FB-01..04 (FB-02 = token expired), 404
// MOTH-NF-01 vehicle not found (NF-02 = URL not found), 429 MOTH-RL-01 daily
// quota (key blocked for 24 h) / MOTH-RL-02 too many requests, 500 MOTH-UN-01.
// errorMessage is never read: it is free text that may echo the registration.
// Rate limits: 500,000 requests a day, burst 10, average 15 requests a second;
// 429 when exceeded; exponential backoff recommended; no Retry-After documented.
//
// Kept: MOT dates, results, odometer readings and defect text. Discarded:
// registrationAtTimeOfTest, motTestNumber, test location, recall status.

import { titleCase } from "@/lib/utils";
import {
  Cooldown,
  createTokenBucket,
  isRecord,
  parseRetryAfterMs,
  requestJson,
  stringField,
  type FetchLike,
  type TokenBucket,
} from "./http";
import { toIsoDate } from "./mot";
import { vehicleLookupError } from "./provider";
import { normalizeRegistration } from "./registration-format";

export const DVSA_MOT_API_BASE_URL = "https://history.mot.api.gov.uk";
export const DVSA_MOT_DEFAULT_SCOPE = "https://tapi.dvsa.gov.uk/.default";

export type MileageUnit = "mi" | "km";

export const MOT_DEFECT_TYPES = [
  "advisory",
  "dangerous",
  "fail",
  "major",
  "minor",
  "non_specific",
  "system_generated",
  "user_entered",
] as const;
export type MotDefectType = (typeof MOT_DEFECT_TYPES)[number] | "unknown";

export type MotDefect = { type: MotDefectType; text: string; dangerous?: boolean };

export type MotTest = {
  /** When the test finished, ISO date-time in UTC. */
  completedDate: string;
  result: "passed" | "failed";
  /** ISO date; passed tests only. */
  expiryDate?: string;
  /** Present only when the odometer was read. */
  odometer?: { value: number; unit: MileageUnit };
  defects: MotDefect[];
};

export type MotHistory = {
  /**
   * Current MOT expiry (ISO date): the latest expiry of a passed test. For a
   * vehicle too new for an MOT this is the first MOT due date, which drives
   * reminders the same way.
   */
  motExpiry?: string;
  /** First MOT due date, only for vehicles with no MOT tests yet. */
  motTestDueDate?: string;
  /** Date of the most recent test (ISO date, Europe/London). */
  lastMotTestDate?: string;
  lastMileage?: number;
  mileageUnit?: MileageUnit;
  /** Most recent first. Empty for a vehicle with no tests yet. */
  motTests: MotTest[];
};

/** What DVSA returns for one vehicle, reduced to vehicle facts. */
export type DvsaVehicle = {
  make?: string;
  model?: string;
  colour?: string;
  fuelType?: string;
  engineCapacityCc?: number;
  year?: number;
  mot: MotHistory;
};

export interface MotHistoryLookup {
  getMotHistory(registration: string): Promise<DvsaVehicle>;
}

const LONDON_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ISO date of an instant in Europe/London. */
export function londonIsoDate(instant: Date) {
  const parts = Object.fromEntries(LONDON_DATE.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function toInstant(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function toMileage(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const digits = value.replace(/[,\s]/g, "");
  return /^\d{1,7}$/.test(digits) ? Number(digits) : undefined;
}

function toUnit(value: unknown): MileageUnit | undefined {
  const unit = typeof value === "string" ? value.trim().toUpperCase() : "";
  return unit === "MI" ? "mi" : unit === "KM" ? "km" : undefined;
}

function toDefectType(value: unknown): MotDefectType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "_") : "";
  return (MOT_DEFECT_TYPES as readonly string[]).includes(normalized) ? (normalized as MotDefectType) : "unknown";
}

function parseDefects(value: unknown): MotDefect[] {
  if (!Array.isArray(value)) return [];
  const defects: MotDefect[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = stringField(item.text)?.replace(/\s+/g, " ").slice(0, 500);
    if (!text) continue;
    const defect: MotDefect = { type: toDefectType(item.type), text };
    if (typeof item.dangerous === "boolean") defect.dangerous = item.dangerous;
    defects.push(defect);
  }
  return defects;
}

function parseTest(value: unknown): MotTest | undefined {
  if (!isRecord(value)) return undefined;
  const completedDate = toInstant(value.completedDate);
  const result = typeof value.testResult === "string" ? value.testResult.trim().toUpperCase() : "";
  if (!completedDate || (result !== "PASSED" && result !== "FAILED")) return undefined;

  const test: MotTest = { completedDate, result: result === "PASSED" ? "passed" : "failed", defects: parseDefects(value.defects) };
  const expiryDate = toIsoDate(value.expiryDate);
  if (expiryDate) test.expiryDate = expiryDate;
  const resultType = typeof value.odometerResultType === "string" ? value.odometerResultType.trim().toUpperCase() : "";
  const mileage = toMileage(value.odometerValue);
  const unit = toUnit(value.odometerUnit);
  if (resultType === "READ" && mileage !== undefined && unit) test.odometer = { value: mileage, unit };
  return test;
}

function yearOf(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) && value > 1880 ? value : undefined;
  const match = typeof value === "string" ? /^(\d{4})/.exec(value.trim()) : null;
  const year = match ? Number(match[1]) : undefined;
  return year && year > 1880 ? year : undefined;
}

/** Reduce a DVSA 200 body to vehicle facts. Registrations in the body are discarded. */
export function parseDvsaVehicle(body: unknown): DvsaVehicle {
  const record = isRecord(body) ? body : {};
  const motTests = (Array.isArray(record.motTests) ? record.motTests : [])
    .map(parseTest)
    .filter((test): test is MotTest => Boolean(test))
    .sort((a, b) => b.completedDate.localeCompare(a.completedDate));

  const mot: MotHistory = { motTests };
  const latestExpiry = motTests
    .filter((test) => test.result === "passed" && test.expiryDate)
    .map((test) => test.expiryDate as string)
    .sort()
    .at(-1);
  const dueDate = motTests.length ? undefined : toIsoDate(record.motTestDueDate);
  if (latestExpiry) mot.motExpiry = latestExpiry;
  else if (dueDate) mot.motExpiry = dueDate;
  if (dueDate) mot.motTestDueDate = dueDate;

  const latest = motTests[0];
  if (latest) mot.lastMotTestDate = londonIsoDate(new Date(latest.completedDate));
  const lastRead = motTests.find((test) => test.odometer);
  if (lastRead?.odometer) {
    mot.lastMileage = lastRead.odometer.value;
    mot.mileageUnit = lastRead.odometer.unit;
  }

  const engine = toMileage(record.engineSize);
  return {
    make: titleCase(stringField(record.make)),
    model: titleCase(stringField(record.model)),
    colour: titleCase(stringField(record.primaryColour)),
    fuelType: titleCase(stringField(record.fuelType)),
    engineCapacityCc: engine && engine > 0 ? engine : undefined,
    year: yearOf(record.manufactureDate) ?? yearOf(record.manufactureYear),
    mot,
  };
}

const DVSA_CODE = /^MOTH-[A-Z]{2}-\d{2}$/;

function dvsaErrorCode(body: unknown) {
  const code = isRecord(body) ? stringField(body.errorCode) : undefined;
  return code && DVSA_CODE.test(code) ? code : undefined;
}

/** Entra error identifiers look like `invalid_client`; anything else is dropped. */
function tokenErrorCode(body: unknown) {
  const code = isRecord(body) ? stringField(body.error) : undefined;
  return code && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
}

export type DvsaCredentials = {
  clientId: string;
  clientSecret: string;
  apiKey: string;
  tokenUrl: string;
  /** Defaults to the documented `https://tapi.dvsa.gov.uk/.default`. */
  scope?: string;
};

export type DvsaClientOptions = DvsaCredentials & {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Refresh this long before the token expires. Default 60 s. */
  tokenRefreshSkewMs?: number;
  /** In-process pacing below DVSA's limits. Default 10 requests a second, burst 10. `false` turns it off. */
  rateLimit?: { ratePerSecond: number; burst: number } | false;
  sleep?: (ms: number) => Promise<void>;
};

const REGISTRATION = /^[A-Z0-9]{2,8}$/;
// MOTH-RL-01 blocks the key for 24 hours. Each instance re-checks at most
// hourly rather than going dark for a day on one misread response.
const DAILY_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
// MOTH-RL-02 and other 429s: 1 s, 2 s, 4 s ... up to a minute, reset on success.
const MAX_BACKOFF_MS = 60 * 1000;

function configurationError(name: string) {
  return new Error(`DVSA MOT History configuration required: ${name} is missing or invalid.`);
}

export class DvsaMotHistoryClient implements MotHistoryLookup {
  private readonly credentials: Required<DvsaCredentials>;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly cooldown: Cooldown;
  private readonly bucket?: TokenBucket;
  private token?: { value: string; refreshAt: number };
  private tokenRequest?: Promise<string>;
  private consecutiveRateLimits = 0;

  constructor(options: DvsaClientOptions) {
    for (const [name, value] of [
      ["DVSA_MOT_CLIENT_ID", options.clientId],
      ["DVSA_MOT_CLIENT_SECRET", options.clientSecret],
      ["DVSA_MOT_API_KEY", options.apiKey],
      ["DVSA_MOT_TOKEN_URL", options.tokenUrl],
    ] as const) {
      if (!value?.trim()) throw configurationError(name);
    }
    if (!isHttpsUrl(options.tokenUrl)) throw configurationError("DVSA_MOT_TOKEN_URL");

    this.credentials = {
      clientId: options.clientId.trim(),
      clientSecret: options.clientSecret.trim(),
      apiKey: options.apiKey.trim(),
      tokenUrl: options.tokenUrl.trim(),
      scope: options.scope?.trim() || DVSA_MOT_DEFAULT_SCOPE,
    };
    this.baseUrl = (options.baseUrl ?? DVSA_MOT_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 6500;
    this.now = options.now ?? Date.now;
    this.skewMs = options.tokenRefreshSkewMs ?? 60_000;
    this.cooldown = new Cooldown(this.now);
    const rateLimit = options.rateLimit ?? { ratePerSecond: 10, burst: 10 };
    if (rateLimit) this.bucket = createTokenBucket({ ...rateLimit, now: this.now, sleep: options.sleep });
  }

  /** The cached bearer token, fetching a new one when it is missing or about to expire. */
  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.token.refreshAt) return this.token.value;
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  /** Forget the cached token (after the API reports it expired). */
  invalidateToken() {
    this.token = undefined;
  }

  private async fetchToken(): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      scope: this.credentials.scope,
    });

    let response;
    try {
      response = await requestJson(this.fetchImpl, this.credentials.tokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }, this.timeoutMs);
    } catch {
      throw vehicleLookupError("unavailable", { source: "dvsa" });
    }

    const accessToken = isRecord(response.body) ? stringField(response.body.access_token) : undefined;
    if (!response.ok || !accessToken) {
      const status = response.status;
      if (status === 429) throw vehicleLookupError("rate_limited", { source: "dvsa", status, retryAfterMs: 1000 });
      throw vehicleLookupError("unavailable", { source: "dvsa", status, upstreamCode: tokenErrorCode(response.body) });
    }

    const rawExpiry = isRecord(response.body) ? Number(response.body.expires_in) : Number.NaN;
    const lifetimeMs = Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry * 1000 : 5 * 60 * 1000;
    // Refresh a minute early, or halfway through a very short lifetime.
    const skew = Math.min(this.skewMs, lifetimeMs / 2);
    this.token = { value: accessToken, refreshAt: this.now() + lifetimeMs - skew };
    return accessToken;
  }

  private async request(registration: string, token: string) {
    try {
      return await requestJson(this.fetchImpl, `${this.baseUrl}/v1/trade/vehicles/registration/${encodeURIComponent(registration)}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "X-API-Key": this.credentials.apiKey },
      }, this.timeoutMs);
    } catch {
      throw vehicleLookupError("unavailable", { source: "dvsa" });
    }
  }

  async getMotHistory(input: string): Promise<DvsaVehicle> {
    const registration = normalizeRegistration(input);
    if (!REGISTRATION.test(registration)) throw vehicleLookupError("invalid", { source: "dvsa" });

    const waitMs = this.cooldown.remainingMs();
    if (waitMs > 0) throw vehicleLookupError("rate_limited", { source: "dvsa", retryAfterMs: waitMs });

    await this.bucket?.take();
    let response = await this.request(registration, await this.getAccessToken());
    let upstreamCode = dvsaErrorCode(response.body);

    // An expired or rejected token gets one fresh token and one retry (GET is safe to repeat).
    if (response.status === 401 || (response.status === 403 && upstreamCode === "MOTH-FB-02")) {
      this.invalidateToken();
      response = await this.request(registration, await this.getAccessToken());
      upstreamCode = dvsaErrorCode(response.body);
    }

    const { status } = response;
    if (status === 200) {
      this.consecutiveRateLimits = 0;
      if (!isRecord(response.body)) throw vehicleLookupError("unavailable", { source: "dvsa", status });
      return parseDvsaVehicle(response.body);
    }
    if (status === 404 && upstreamCode !== "MOTH-NF-02") throw vehicleLookupError("not_found", { source: "dvsa", status, upstreamCode });
    if (status === 400) throw vehicleLookupError("invalid", { source: "dvsa", status, upstreamCode });
    if (status === 429) {
      this.consecutiveRateLimits += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.consecutiveRateLimits - 1));
      const retryAfterMs = upstreamCode === "MOTH-RL-01"
        ? DAILY_QUOTA_COOLDOWN_MS
        : parseRetryAfterMs(response.headers.get("retry-after"), this.now()) ?? backoff;
      this.cooldown.extend(retryAfterMs);
      throw vehicleLookupError("rate_limited", { source: "dvsa", status, upstreamCode, retryAfterMs });
    }
    throw vehicleLookupError("unavailable", { source: "dvsa", status, upstreamCode });
  }
}

function isHttpsUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
