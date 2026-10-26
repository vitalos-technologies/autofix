import "server-only";

// Twilio SMS and WhatsApp adapters, webhook signature checks and status mapping.
//
// Docs read 26 Oct 2026:
// - Messages resource (create, params, statuses):
//   https://www.twilio.com/docs/messaging/api/message-resource
//   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json,
//   application/x-www-form-urlencoded; To, From or MessagingServiceSid, Body
//   (up to 1,600 characters), StatusCallback, ContentSid + ContentVariables.
//   With MessagingServiceSid and no From the first status is `accepted`; if
//   both are sent, From must be in the service's sender pool.
// - Webhook security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//   and https://www.twilio.com/docs/usage/security (dateModified 14 Oct 2026):
//   X-Twilio-Signature = Base64(HMAC-SHA1(authToken, url + each POST param
//   name and value, sorted by name, no delimiters)). Use the exact URL Twilio
//   called (query string included, never re-encoded); Twilio may keep or drop
//   the port, so both forms are checked.
// - Status callbacks: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
//   (form-encoded POST with MessageSid, MessageStatus, ErrorCode; callbacks can
//   arrive out of order, so only move status forward: isLaterStatus).
// - WhatsApp: https://www.twilio.com/docs/whatsapp/api and
//   https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates
//   Addresses are `whatsapp:<E.164>`. Outside the 24-hour customer service
//   window a business-initiated message must be an approved template
//   (ContentSid, ContentVariables {"1": ...}); a free-form body fails with
//   63016 (https://www.twilio.com/docs/api/errors/63016), usually reported
//   later in the status callback rather than on create.
// - Errors: https://www.twilio.com/docs/usage/twilios-response (JSON `code`,
//   `message`, `more_info`, `status`; 401 bad credentials, 429 concurrency
//   limit, 503 retry later), 21211 invalid To, 21614 To not a mobile,
//   21610 unsubscribed recipient. Other codes below are from Twilio's error
//   dictionary as known to the author; check before relying on a new one.
// - Test credentials: https://www.twilio.com/docs/iam/test-credentials (no
//   real messages, no charge, no status callbacks). Magic To numbers:
//   +15005550001 (21211), +15005550002 (21612), +15005550003 (21408),
//   +15005550004 (21610), +15005550009 (21614).
//
// Idempotency: the Messages resource has no idempotency key. We never retry
// inside send(); a successful result is cached per process by
// (kind, garageId, idempotencyKey) so a retried job in the same instance does
// not text twice. Cross-instance protection is the caller's job (claim the
// reminder_sends / messages row before sending). Timeouts and connection
// resets come back `ambiguous: true, retryable: false` because Twilio may
// already have accepted the message.
//
// Alphanumeric senders are one-way: a customer cannot reply STOP to
// `HartleyRd`. Messages from an alphanumeric sender need another opt-out
// route (the /r/{token}/stop page) or a two-way number.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelKind, DeliveryStatus, MessageChannel, OutboundMessage, SendResult } from "./channel";
import { classifyInbound, type InboundIntent } from "./keywords";
import { isE164 } from "./phone";
import { bodyProblem, configurationRequired, isValidAlphanumericSenderId, sendFailure, sendSuccess } from "./results";

export const TWILIO_API_BASE_URL = "https://api.twilio.com";
export const TWILIO_DEFAULT_TIMEOUT_MS = 10_000;
/** WhatsApp: free-form message outside the 24-hour window; use a template. */
export const TWILIO_ERROR_WHATSAPP_OUTSIDE_WINDOW = 63016;

type TwilioCommonOptions = {
  accountSid: string;
  authToken: string;
  /** Default StatusCallback when the message does not set one. */
  statusCallbackUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  /** Per-process cache of successful sends by idempotency key. Defaults to a shared module cache. */
  idempotencyCache?: Map<string, SendResult>;
};

export type TwilioSmsChannelOptions = TwilioCommonOptions & {
  /** Preferred sender: Twilio picks from the service's sender pool. */
  messagingServiceSid?: string;
  /** Fallback sender (E.164 number or alphanumeric) when there is no Messaging Service. */
  from?: string;
};

export type TwilioWhatsAppChannelOptions = TwilioCommonOptions & {
  /** The approved WhatsApp sender, E.164 with or without `whatsapp:`. */
  whatsappFrom: string;
  /** Optional; only when the WhatsApp sender is in this service's sender pool. */
  messagingServiceSid?: string;
};

// ---------------------------------------------------------------------------
// Error and status mapping

const INVALID_RECIPIENT_CODES = new Set([
  21211, // Invalid 'To' phone number
  21612, // Cannot route to this number
  21614, // 'To' is not a valid mobile number
  63003, // WhatsApp: channel could not find the To address
  63024, // WhatsApp: invalid message recipient
]);
const OPTED_OUT_CODES = new Set([21610]); // Attempt to send to unsubscribed recipient
const CONFIGURATION_CODES = new Set([
  20003, // Authentication failed
  20404, // Resource not found (wrong Account SID)
  21212, // Invalid 'From' number
  21408, // Permission to send to this region is not enabled
  21606, // 'From' is not a valid message-capable number for this account
  21608, // Trial account: 'To' is not verified
  21659, // 'From' is not a Twilio number
  21703, // Messaging Service has no sender available
  21705, // Invalid Messaging Service
  63007, // WhatsApp: channel could not find the From address
]);
const RATE_LIMIT_CODES = new Set([20429, 14107]);

function retryAfterSeconds(header: string | null | undefined) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Maps a Twilio REST error (HTTP status + Twilio `code`) to a SendResult failure. */
export function mapTwilioError(httpStatus: number, twilioCode?: number | null, retryAfter?: string | null): SendResult {
  const code = typeof twilioCode === "number" && Number.isFinite(twilioCode) ? twilioCode : undefined;
  const providerCode = code ?? httpStatus;

  if (code !== undefined) {
    if (OPTED_OUT_CODES.has(code)) return sendFailure("opted_out", false, { providerCode });
    if (INVALID_RECIPIENT_CODES.has(code)) return sendFailure("invalid_recipient", false, { providerCode });
    if (CONFIGURATION_CODES.has(code)) return configurationRequired(providerCode);
    if (RATE_LIMIT_CODES.has(code)) return sendFailure("rate_limited", true, { providerCode, retryAfterSeconds: retryAfterSeconds(retryAfter) });
  }
  if (httpStatus === 429) return sendFailure("rate_limited", true, { providerCode, retryAfterSeconds: retryAfterSeconds(retryAfter) });
  if (httpStatus === 401 || httpStatus === 403) return configurationRequired(providerCode);
  if (httpStatus >= 500) return sendFailure("provider_error", true, { providerCode, retryAfterSeconds: retryAfterSeconds(retryAfter) });
  return sendFailure("provider_error", false, { providerCode });
}

const STATUS_MAP: Record<string, DeliveryStatus> = {
  accepted: "queued",
  scheduled: "queued",
  queued: "queued",
  sending: "queued",
  sent: "sent",
  partially_delivered: "sent",
  delivered: "delivered",
  read: "delivered",
  received: "delivered",
  receiving: "delivered",
  failed: "failed",
  undelivered: "failed",
  canceled: "failed",
};

/** Twilio message status to our DeliveryStatus. Unknown values are `queued`, the lowest rank, so they never overwrite a later state. */
export function mapTwilioStatus(status: string | null | undefined): DeliveryStatus {
  return STATUS_MAP[status?.trim().toLowerCase() ?? ""] ?? "queued";
}

const STATUS_RANK: Record<DeliveryStatus, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };

/**
 * Status callbacks can arrive out of order. Apply `next` only when it moves
 * the message forward: queued -> sent -> delivered or failed. Once delivered
 * or failed the status is final.
 */
export function isLaterStatus(current: DeliveryStatus | null | undefined, next: DeliveryStatus): boolean {
  if (!current) return true;
  if (current === "delivered" || current === "failed") return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}

// ---------------------------------------------------------------------------
// Webhook signatures and parsing

export type TwilioParams = Record<string, string | readonly string[]> | URLSearchParams;

function sortedParamEntries(params: TwilioParams): Array<[string, string[]]> {
  const grouped = new Map<string, string[]>();
  const add = (key: string, value: string) => {
    const values = grouped.get(key);
    if (values) values.push(value);
    else grouped.set(key, [value]);
  };
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params) add(key, value);
  } else {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") add(key, value);
      else for (const item of value) add(key, item);
    }
  }
  return [...grouped.keys()].sort().map((key) => [key, [...(grouped.get(key) ?? [])].sort()]);
}

/** Twilio's documented algorithm. Exported so tests and local tools can sign fake webhooks. */
export function computeTwilioSignature(url: string, params: TwilioParams, authToken: string): string {
  let data = url;
  for (const [key, values] of sortedParamEntries(params)) {
    for (const value of values) data += key + value;
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** The URL as given, plus the same URL with the default port added or removed (Twilio may sign either). */
function signatureUrlVariants(url: string) {
  const variants = new Set([url]);
  const match = /^(https?):\/\/([^/?#]*)(.*)$/is.exec(url);
  if (!match) return [...variants];
  const [, scheme = "", authority = "", rest = ""] = match;
  const host = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  const defaultPort = scheme.toLowerCase() === "https" ? "443" : "80";
  const portMatch = /^(.*):(\d+)$/.exec(host);
  if (portMatch) {
    if (portMatch[2] === defaultPort) variants.add(`${scheme}://${portMatch[1]}${rest}`);
  } else {
    variants.add(`${scheme}://${host}:${defaultPort}${rest}`);
  }
  if (host !== authority) variants.add(`${scheme}://${host}${rest}`);
  return [...variants];
}

function safeEqual(expected: string, provided: string) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export type VerifyTwilioSignatureInput = {
  /** The exact public URL Twilio requested, including any query string. */
  url: string;
  /** The form-encoded POST parameters (pass `new URLSearchParams(rawBody)` to keep repeated keys exact). */
  params: TwilioParams;
  /** The `X-Twilio-Signature` header. */
  signature: string | null | undefined;
  authToken: string;
};

/** Constant-time check of `X-Twilio-Signature`. False for any missing input. */
export function verifyTwilioSignature(input: VerifyTwilioSignatureInput): boolean;
export function verifyTwilioSignature(url: string, params: TwilioParams, signature: string | null | undefined, authToken: string): boolean;
export function verifyTwilioSignature(
  inputOrUrl: VerifyTwilioSignatureInput | string,
  params?: TwilioParams,
  signature?: string | null,
  authToken?: string,
): boolean {
  const input: Partial<VerifyTwilioSignatureInput> =
    typeof inputOrUrl === "string" ? { url: inputOrUrl, params, signature, authToken } : inputOrUrl;
  if (!input.url || !input.params || !input.signature || !input.authToken) return false;
  const provided = input.signature.trim();
  let valid = false;
  for (const candidate of signatureUrlVariants(input.url)) {
    // Check every variant so timing does not reveal which one matched.
    if (safeEqual(computeTwilioSignature(candidate, input.params, input.authToken), provided)) valid = true;
  }
  return valid;
}

/** Parses a form-encoded webhook body. First value wins for a repeated key (Twilio messaging webhooks do not repeat keys). */
export function parseTwilioForm(rawBody: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function stripWhatsApp(address: string | undefined) {
  return address?.trim().replace(/^whatsapp:/i, "") ?? "";
}

export type TwilioStatusCallback = {
  messageSid: string;
  rawStatus: string;
  status: DeliveryStatus;
  /** Twilio ErrorCode when failed or undelivered (63016 = WhatsApp outside the 24-hour window). */
  errorCode: number | null;
  to: string | null;
  from: string | null;
};

/** Reads an outbound status callback. Null when it carries no MessageSid. */
export function parseTwilioStatusCallback(params: Record<string, string | undefined>): TwilioStatusCallback | null {
  const messageSid = (params.MessageSid ?? params.SmsSid)?.trim();
  if (!messageSid) return null;
  const rawStatus = (params.MessageStatus ?? params.SmsStatus ?? "").trim().toLowerCase();
  const errorCode = params.ErrorCode ? Number(params.ErrorCode) : NaN;
  return {
    messageSid,
    rawStatus,
    status: mapTwilioStatus(rawStatus),
    errorCode: Number.isFinite(errorCode) ? errorCode : null,
    to: stripWhatsApp(params.To) || null,
    from: stripWhatsApp(params.From) || null,
  };
}

export type TwilioInboundMessage = {
  messageSid: string;
  channel: Extract<ChannelKind, "sms" | "whatsapp">;
  /** Sender in E.164, `whatsapp:` removed. */
  from: string;
  /** The garage's number in E.164, `whatsapp:` removed. Use it to find the garage. */
  to: string;
  body: string;
  numMedia: number;
  /** STOP / START / HELP from the body, or Twilio's OptOutType when present. */
  intent: InboundIntent;
};

/** Reads an inbound SMS or WhatsApp webhook. Null when required fields are missing or malformed. */
export function parseTwilioInboundMessage(params: Record<string, string | undefined>): TwilioInboundMessage | null {
  const messageSid = (params.MessageSid ?? params.SmsMessageSid)?.trim();
  const rawFrom = params.From?.trim() ?? "";
  const from = stripWhatsApp(rawFrom);
  const to = stripWhatsApp(params.To);
  if (!messageSid || !isE164(from) || !isE164(to)) return null;
  const body = params.Body ?? "";
  const numMedia = Number(params.NumMedia ?? 0);
  return {
    messageSid,
    channel: /^whatsapp:/i.test(rawFrom) ? "whatsapp" : "sms",
    from,
    to,
    body,
    numMedia: Number.isFinite(numMedia) ? numMedia : 0,
    intent: classifyInbound(body, { optOutType: params.OptOutType }),
  };
}

// ---------------------------------------------------------------------------
// Outbound adapters

const sharedIdempotencyCache = new Map<string, SendResult>();
const IDEMPOTENCY_CACHE_LIMIT = 1000;

function rememberResult(cache: Map<string, SendResult>, key: string, result: SendResult) {
  cache.set(key, result);
  while (cache.size > IDEMPOTENCY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function connectionNeverOpened(error: unknown) {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(cause.code);
}

type TwilioMessagePayload = { sid?: unknown; status?: unknown; code?: unknown };

async function readJson(response: Response): Promise<TwilioMessagePayload | null> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === "object" ? (parsed as TwilioMessagePayload) : null;
  } catch {
    return null;
  }
}

function messagesUrl(baseUrl: string, accountSid: string) {
  return `${baseUrl.replace(/\/+$/, "")}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

function basicAuth(accountSid: string, authToken: string) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64")}`;
}

async function postMessage(options: TwilioCommonOptions, kind: ChannelKind, message: OutboundMessage, form: URLSearchParams): Promise<SendResult> {
  const cache = options.idempotencyCache ?? sharedIdempotencyCache;
  const cacheKey = message.idempotencyKey ? `${kind}\u0000${message.garageId}\u0000${message.idempotencyKey}` : null;
  const cached = cacheKey ? cache.get(cacheKey) : undefined;
  if (cached) return cached;

  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TWILIO_DEFAULT_TIMEOUT_MS);

  try {
    const response = await doFetch(messagesUrl(options.baseUrl ?? TWILIO_API_BASE_URL, options.accountSid), {
      method: "POST",
      headers: {
        Authorization: basicAuth(options.accountSid, options.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: controller.signal,
      cache: "no-store",
    });

    const payload = await readJson(response);

    if (!response.ok) {
      return mapTwilioError(response.status, typeof payload?.code === "number" ? payload.code : null, response.headers.get("retry-after"));
    }
    if (typeof payload?.sid !== "string" || !payload.sid) {
      return sendFailure("provider_error", false, { providerCode: "unexpected_response", ambiguous: true });
    }

    const result = sendSuccess(payload.sid, mapTwilioStatus(typeof payload.status === "string" ? payload.status : undefined));
    if (cacheKey) rememberResult(cache, cacheKey, result);
    return result;
  } catch (error) {
    if (isAbortError(error)) return sendFailure("provider_error", false, { providerCode: "timeout", ambiguous: true });
    if (connectionNeverOpened(error)) return sendFailure("provider_error", true, { providerCode: "network" });
    return sendFailure("provider_error", false, { providerCode: "network", ambiguous: true });
  } finally {
    clearTimeout(timeout);
  }
}

function hasCredentials(options: TwilioCommonOptions) {
  return Boolean(options.accountSid?.trim() && options.authToken?.trim());
}

/** Twilio SMS. Sender: the message's alphanumeric senderId, else the Messaging Service, else `from`. */
export function createTwilioSmsChannel(options: TwilioSmsChannelOptions): MessageChannel {
  return {
    kind: "sms",
    mode: "live",
    async send(message) {
      if (!hasCredentials(options)) return configurationRequired();
      if (!isE164(message.to)) return sendFailure("invalid_recipient", false, { providerCode: "invalid_e164" });
      const problem = bodyProblem(message.body);
      if (problem) return problem;

      const form = new URLSearchParams();
      form.set("To", message.to);
      if (message.senderId !== undefined) {
        // A per-garage alphanumeric sender is not in the shared service's pool, so send it as From on its own.
        if (!isValidAlphanumericSenderId(message.senderId)) return configurationRequired("invalid_sender_id");
        form.set("From", message.senderId);
      } else if (options.messagingServiceSid) {
        form.set("MessagingServiceSid", options.messagingServiceSid);
      } else if (options.from) {
        form.set("From", options.from);
      } else {
        return configurationRequired("no_sender");
      }
      form.set("Body", message.body);
      const statusCallback = message.statusCallbackUrl ?? options.statusCallbackUrl;
      if (statusCallback) form.set("StatusCallback", statusCallback);

      return postMessage(options, "sms", message, form);
    },
  };
}

/** Twilio WhatsApp. Uses `whatsapp:` addressing; sends the approved template when `whatsappTemplate` is set. */
export function createTwilioWhatsAppChannel(options: TwilioWhatsAppChannelOptions): MessageChannel {
  return {
    kind: "whatsapp",
    mode: "live",
    async send(message) {
      if (!hasCredentials(options)) return configurationRequired();
      const sender = stripWhatsApp(options.whatsappFrom);
      if (!isE164(sender)) return configurationRequired("no_sender");
      const recipient = stripWhatsApp(message.to);
      if (!isE164(recipient)) return sendFailure("invalid_recipient", false, { providerCode: "invalid_e164" });

      const template = message.whatsappTemplate;
      if (template && !/^HX[0-9a-fA-F]{32}$/.test(template.contentSid)) return configurationRequired("invalid_content_sid");
      const problem = bodyProblem(message.body, Boolean(template));
      if (problem) return problem;

      const form = new URLSearchParams();
      form.set("To", `whatsapp:${recipient}`);
      form.set("From", `whatsapp:${sender}`);
      if (options.messagingServiceSid) form.set("MessagingServiceSid", options.messagingServiceSid);
      if (template) {
        form.set("ContentSid", template.contentSid);
        if (template.variables && Object.keys(template.variables).length > 0) {
          form.set("ContentVariables", JSON.stringify(template.variables));
        }
      } else {
        form.set("Body", message.body);
      }
      const statusCallback = message.statusCallbackUrl ?? options.statusCallbackUrl;
      if (statusCallback) form.set("StatusCallback", statusCallback);

      return postMessage(options, "whatsapp", message, form);
    },
  };
}
