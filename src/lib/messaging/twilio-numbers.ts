/**
 * Twilio phone numbers adapter (D22): read the account, its numbers, the Messaging Service's numbers,
 * approved regulatory bundles and addresses; search, buy and add numbers. The provisioning logic that
 * decides what to buy is `src/lib/phone-numbers/provision.ts`; this file only talks to Twilio.
 *
 * Official Twilio docs read on 29 Oct 2026 (page dateModified in brackets):
 * - Account, GET /2010-04-01/Accounts/{Sid}.json: `type` is `Trial` or `Full` ("Full if it's been upgraded"),
 *   `status` active / suspended / closed. https://www.twilio.com/docs/iam/api/account (2026-09-28)
 * - IncomingPhoneNumber, GET/POST /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json: list (PageSize
 *   max 1000, `incoming_phone_numbers`, `next_page_uri`; filters PhoneNumber, FriendlyName) and buy (PhoneNumber,
 *   FriendlyName up to 64 characters, VoiceUrl, VoiceMethod, StatusCallback, StatusCallbackMethod, AddressSid,
 *   BundleSid). Fields: sid (PN…), phone_number, friendly_name, capabilities {voice, sms, mms, fax}.
 *   https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource (2026-05-04)
 * - AvailablePhoneNumbers, GET …/AvailablePhoneNumbers/GB/Local.json and …/Mobile.json: SmsEnabled, VoiceEnabled,
 *   Contains (2–16 characters; a leading `+` matches the start, e.g. `+4420` for London), PageSize; AreaCode,
 *   NearNumber, InRegion and the other location filters are US/Canada only. Response `available_phone_numbers`
 *   with phone_number, address_requirements (none/any/local/foreign), capabilities.
 *   https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource (2026-03-09),
 *   https://www.twilio.com/docs/phone-numbers/api/availablephonenumber-mobile-resource (2026-03-09)
 * - Regulatory Compliance Bundles, GET https://numbers.twilio.com/v2/RegulatoryCompliance/Bundles: Status
 *   (`twilio-approved`, …), IsoCountry, NumberType (local/mobile/national/toll-free), EndUserType
 *   (individual/business), PageSize; response `results`, `meta.next_page_url`; sid BU…. Public Beta.
 *   https://www.twilio.com/docs/phone-numbers/regulatory/api/bundles (2026-03-09)
 * - Address, GET /2010-04-01/Accounts/{AccountSid}/Addresses.json?IsoCountry=GB: `addresses`, sid AD….
 *   https://www.twilio.com/docs/usage/api/address (2026-07-20)
 * - Messaging Service numbers, GET/POST https://messaging.twilio.com/v1/Services/{ServiceSid}/PhoneNumbers
 *   (PhoneNumberSid): `phone_numbers`, `capabilities` is an array of strings ("SMS", "Voice", "MMS"); 400 numbers
 *   per service by default; removing a number from a service does not release it.
 *   https://www.twilio.com/docs/messaging/api/phonenumber-resource (2025-09-25)
 * - Errors: 21404 "Inbound Phone number not available to trial account" (buying needs an upgraded account),
 *   21649 "Phone Number Requires a Bundle", 21631 "Phone Number Requires an Address" (21615: needs a local
 *   address, from the Address page), 21422 "PhoneNumber is not available", 20429 / HTTP 429 "Too many requests"
 *   ("aren't processed and are safe to retry after backing off").
 *   https://www.twilio.com/docs/api/errors/21404, /21649, /21631, /21422, /20429
 * - Rate limits: https://www.twilio.com/docs/usage/rest-api-best-practices (2026-07-20): back off on 429.
 *   Neither page documents Retry-After or an idempotency key for REST POSTs.
 *
 * Idempotency: buying has no idempotency key, so a purchase is never retried here. Every number we buy gets a
 * FriendlyName that names what it is for (`Autofix texts`, `Autofix desk <garage id>`); a run that cannot tell
 * whether a purchase went through finds the number by that name on the next run instead of buying again.
 * GET requests are retried once after a short back-off on 429, 5xx or a network error.
 *
 * Credentials come only from env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID) and live
 * only in the client's closure: never logged, never put in an error, never exposed on the object.
 */
import "server-only";

import { readTwilioConfig, type MessagingEnv } from "./config";
import {
  isTwilioNumbersError,
  mapTwilioNumbersError,
  TwilioNumbersError,
  type AvailableNumber,
  type OwnedNumber,
  type ServiceNumber,
  type TwilioNumbersClient,
  type TwilioNumbersMode,
} from "./twilio-numbers-contract";
import { createMockTwilioNumbersClient, type MockTwilioNumbersClient } from "./twilio-numbers-mock";

export {
  isTwilioNumbersError,
  mapTwilioNumbersError,
  TwilioNumbersError,
  type AvailableNumber,
  type BuyNumberInput,
  type NumberKind,
  type OwnedNumber,
  type SearchOptions,
  type ServiceNumber,
  type TwilioAccount,
  type TwilioNumbersClient,
  type TwilioNumbersErrorKind,
  type TwilioNumbersMode,
} from "./twilio-numbers-contract";
export { createMockTwilioNumbersClient, type MockTwilioNumbersClient, type MockTwilioNumbersOptions } from "./twilio-numbers-mock";

export const TWILIO_NUMBERS_MODE_ENV = "TWILIO_NUMBERS_MODE";
const API_BASE_URL = "https://api.twilio.com";
const MESSAGING_BASE_URL = "https://messaging.twilio.com";
const NUMBERS_BASE_URL = "https://numbers.twilio.com";
const GET_TIMEOUT_MS = 8_000;
const POST_TIMEOUT_MS = 10_000;
const MAX_PAGES = 5;
const MAX_BACKOFF_MS = 2_000;

// ---------------------------------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------------------------------

export type TwilioNumbersClientOptions = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  fetch?: typeof fetch;
  /** Waits between a GET and its one retry (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  getTimeoutMs?: number;
  postTimeoutMs?: number;
};

type Json = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const bool = (value: unknown) => value === true;

function ownedNumber(row: Json): OwnedNumber {
  const capabilities = (row.capabilities ?? {}) as Json;
  return {
    sid: text(row.sid),
    phoneNumber: text(row.phone_number),
    friendlyName: text(row.friendly_name),
    sms: bool(capabilities.sms) || bool(capabilities.SMS),
    voice: bool(capabilities.voice) || bool(capabilities.Voice),
  };
}

function serviceNumber(row: Json): ServiceNumber {
  const raw = row.capabilities;
  const capabilities = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : Object.entries((raw ?? {}) as Json).filter(([, on]) => on === true).map(([name]) => name.toUpperCase() === "SMS" ? "SMS" : name);
  return { sid: text(row.sid), phoneNumber: text(row.phone_number), capabilities };
}

function availableNumber(row: Json): AvailableNumber {
  const capabilities = (row.capabilities ?? {}) as Json;
  return {
    phoneNumber: text(row.phone_number),
    sms: bool(capabilities.sms) || bool(capabilities.SMS),
    voice: bool(capabilities.voice) || bool(capabilities.Voice),
    addressRequirements: text(row.address_requirements) || "none",
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The live client. Construct it through `getTwilioNumbersClient(env)` in the app. */
export function createTwilioNumbersClient(options: TwilioNumbersClientOptions): TwilioNumbersClient {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const getTimeout = options.getTimeoutMs ?? GET_TIMEOUT_MS;
  const postTimeout = options.postTimeoutMs ?? POST_TIMEOUT_MS;
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;
  const account = encodeURIComponent(options.accountSid);
  const service = encodeURIComponent(options.messagingServiceSid);
  const accountApi = `${API_BASE_URL}/2010-04-01/Accounts/${account}`;

  async function send(operation: string, url: string, init: RequestInit, timeoutMs: number): Promise<Json> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers: { Authorization: authorization, Accept: "application/json", ...init.headers }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TwilioNumbersError("timeout", `Twilio ${operation}: ${timedOut ? "timed out" : "network error"}`);
    }
    const raw = await response.text().catch(() => "");
    let body: Json = {};
    try {
      body = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const code = typeof body.code === "number" ? body.code : null;
      throw mapTwilioNumbersError(operation, response.status, code, response.headers.get("retry-after"));
    }
    return body;
  }

  /** GET with one retry after a short back-off on 429, 5xx or a network error (reads are safe to repeat). */
  async function get(operation: string, url: string): Promise<Json> {
    try {
      return await send(operation, url, { method: "GET" }, getTimeout);
    } catch (error) {
      if (!isTwilioNumbersError(error) || !["rate_limited", "provider_error", "timeout"].includes(error.kind)) throw error;
      await sleep(Math.min(MAX_BACKOFF_MS, error.retryAfterMs ?? 500));
      return send(operation, url, { method: "GET" }, getTimeout);
    }
  }

  function post(operation: string, url: string, fields: Record<string, string>): Promise<Json> {
    return send(operation, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }, postTimeout);
  }

  /** Follows `next` links (absolute, or relative to the API host) for up to MAX_PAGES pages. */
  async function pages(operation: string, first: string, key: string, next: (body: Json) => string | null): Promise<Json[]> {
    const rows: Json[] = [];
    let url: string | null = first;
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const body = await get(operation, url);
      const items = body[key];
      if (Array.isArray(items)) rows.push(...(items as Json[]));
      const link = next(body);
      url = link ? (link.startsWith("http") ? link : `${API_BASE_URL}${link}`) : null;
    }
    return rows;
  }

  return {
    mode: "live",

    async getAccount() {
      const body = await get("account", `${accountApi}.json`);
      return { type: text(body.type) || "unknown", status: text(body.status) || "unknown" };
    },

    async listNumbers() {
      const rows = await pages("numbers", `${accountApi}/IncomingPhoneNumbers.json?PageSize=1000`, "incoming_phone_numbers", (body) => text(body.next_page_uri) || null);
      return rows.map(ownedNumber).filter((row) => row.sid && row.phoneNumber);
    },

    async listServiceNumbers() {
      const rows = await pages(
        "service numbers",
        `${MESSAGING_BASE_URL}/v1/Services/${service}/PhoneNumbers?PageSize=1000`,
        "phone_numbers",
        (body) => text(((body.meta ?? {}) as Json).next_page_url) || null,
      );
      return rows.map(serviceNumber).filter((row) => row.sid && row.phoneNumber);
    },

    async findApprovedBundle(kind, endUserType) {
      const query = new URLSearchParams({ Status: "twilio-approved", IsoCountry: "GB", NumberType: kind, PageSize: "20" });
      if (endUserType) query.set("EndUserType", endUserType);
      const body = await get("bundles", `${NUMBERS_BASE_URL}/v2/RegulatoryCompliance/Bundles?${query}`);
      const results = Array.isArray(body.results) ? (body.results as Json[]) : [];
      return results.map((row) => text(row.sid)).find((sid) => /^BU[0-9a-fA-F]{32}$/.test(sid)) ?? null;
    },

    async findAddress() {
      const body = await get("addresses", `${accountApi}/Addresses.json?IsoCountry=GB&PageSize=20`);
      const addresses = Array.isArray(body.addresses) ? (body.addresses as Json[]) : [];
      return addresses.map((row) => text(row.sid)).find((sid) => /^AD[0-9a-fA-F]{32}$/.test(sid)) ?? null;
    },

    async searchAvailable(kind, options = {}) {
      const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: String(Math.min(Math.max(options.limit ?? 5, 1), 20)) });
      if (options.sms) query.set("SmsEnabled", "true");
      if (options.contains) query.set("Contains", options.contains);
      const body = await get("available numbers", `${accountApi}/AvailablePhoneNumbers/GB/${kind === "mobile" ? "Mobile" : "Local"}.json?${query}`);
      const rows = Array.isArray(body.available_phone_numbers) ? (body.available_phone_numbers as Json[]) : [];
      return rows.map(availableNumber).filter((row) => row.phoneNumber);
    },

    async buyNumber(input) {
      const fields: Record<string, string> = {
        PhoneNumber: input.phoneNumber,
        FriendlyName: input.friendlyName.slice(0, 64),
        VoiceUrl: input.voiceUrl,
        VoiceMethod: "POST",
        StatusCallback: input.voiceUrl,
        StatusCallbackMethod: "POST",
        BundleSid: input.bundleSid,
      };
      if (input.addressSid) fields.AddressSid = input.addressSid;
      const body = await post("buy number", `${accountApi}/IncomingPhoneNumbers.json`, fields);
      const bought = ownedNumber(body);
      if (!bought.sid || !bought.phoneNumber) throw new TwilioNumbersError("timeout", "Twilio buy number: unreadable answer");
      return bought;
    },

    async addToService(numberSid) {
      await post("add to service", `${MESSAGING_BASE_URL}/v1/Services/${service}/PhoneNumbers`, { PhoneNumberSid: numberSid });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export type TwilioNumbersReadiness = {
  mode: TwilioNumbersMode | "invalid";
  /** `operational` (live, production, credentials set), `mock`, or `configuration_required`. */
  status: "operational" | "mock" | "configuration_required";
  /** Names of missing or wrong settings. Never values. */
  missing: string[];
};

/**
 * What the numbers integration will do here, without any value:
 * - `TWILIO_NUMBERS_MODE=live` on the production deployment (`VERCEL_ENV=production`) with the Twilio account
 *   SID, auth token and Messaging Service SID: operational (it may buy numbers).
 * - `live` anywhere else (preview deployments, a laptop): configuration_required. Purchases only ever run on
 *   production, so a preview that shares the database or a developer's `.env.local` can never buy a number.
 * - unset or `mock`: the in-memory mock (a trial account), except on production, which fails closed.
 */
export function getTwilioNumbersReadiness(env: MessagingEnv = process.env): TwilioNumbersReadiness {
  const rawMode = (env[TWILIO_NUMBERS_MODE_ENV] ?? "").trim().toLowerCase() || "mock";
  if (rawMode !== "mock" && rawMode !== "live") return { mode: "invalid", status: "configuration_required", missing: [TWILIO_NUMBERS_MODE_ENV] };
  const production = env.VERCEL_ENV?.trim() === "production";
  if (rawMode === "live") {
    const twilio = readTwilioConfig(env);
    const missing: string[] = [];
    if (!twilio.accountSid) missing.push("TWILIO_ACCOUNT_SID");
    if (!twilio.authToken) missing.push("TWILIO_AUTH_TOKEN");
    if (!twilio.messagingServiceSid) missing.push("TWILIO_MESSAGING_SERVICE_SID");
    if (!production) missing.push("VERCEL_ENV");
    return { mode: "live", status: missing.length ? "configuration_required" : "operational", missing };
  }
  if (production) return { mode: "mock", status: "configuration_required", missing: [TWILIO_NUMBERS_MODE_ENV] };
  return { mode: "mock", status: "mock", missing: [] };
}

const MOCK_SINGLETON = Symbol.for("autofix.twilio.mockNumbersClient");

/** The shared in-memory mock for dev and preview: a trial account, so it never pretends to buy anything. */
export function sharedMockTwilioNumbersClient(): MockTwilioNumbersClient {
  const store = globalThis as typeof globalThis & { [MOCK_SINGLETON]?: MockTwilioNumbersClient };
  store[MOCK_SINGLETON] ??= createMockTwilioNumbersClient({ accountType: "Trial" });
  return store[MOCK_SINGLETON];
}

/** The numbers client for this environment, or a `configuration_required` error (see getTwilioNumbersReadiness). */
export function getTwilioNumbersClient(env: MessagingEnv = process.env): TwilioNumbersClient {
  const readiness = getTwilioNumbersReadiness(env);
  if (readiness.status === "configuration_required") {
    throw new TwilioNumbersError("configuration_required", `Twilio numbers need ${readiness.missing.join(", ")}.`);
  }
  if (readiness.mode === "live") {
    const twilio = readTwilioConfig(env);
    return createTwilioNumbersClient({
      accountSid: twilio.accountSid ?? "",
      authToken: twilio.authToken ?? "",
      messagingServiceSid: twilio.messagingServiceSid ?? "",
    });
  }
  return sharedMockTwilioNumbersClient();
}
