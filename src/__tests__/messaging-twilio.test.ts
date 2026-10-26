import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OutboundMessage, SendResult } from "@/lib/messaging/channel";
import {
  computeTwilioSignature,
  createTwilioSmsChannel,
  createTwilioWhatsAppChannel,
  isLaterStatus,
  mapTwilioError,
  mapTwilioStatus,
  parseTwilioForm,
  parseTwilioInboundMessage,
  parseTwilioStatusCallback,
  TWILIO_ERROR_WHATSAPP_OUTSIDE_WINDOW,
  verifyTwilioSignature,
} from "@/lib/messaging/twilio";

// Fake credentials: the right shape, never real.
const accountSid = `AC${"0123456789abcdef".repeat(2)}`;
const authToken = "fake-auth-token-for-tests-only";
const messagingServiceSid = `MG${"fedcba9876543210".repeat(2)}`;
const contentSid = `HX${"a".repeat(32)}`;

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(...responses: Array<Response | Error>) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift() ?? json(201, { sid: "SM_default", status: "queued" });
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

let keySequence = 0;
function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  keySequence += 1;
  return {
    garageId: "11111111-1111-4111-8111-111111111111",
    to: "+447700900123",
    body: "Hi Sam, your MOT is due. Reply STOP to opt out.",
    idempotencyKey: `test:${keySequence}`,
    ...overrides,
  };
}

function formOf(call: FetchCall | undefined) {
  return Object.fromEntries(new URLSearchParams(String(call?.init.body ?? "")));
}

function header(call: FetchCall | undefined, name: string) {
  return new Headers(call?.init.headers).get(name);
}

describe("Twilio SMS adapter", () => {
  it("posts a form-encoded message with basic auth to the Messages resource", async () => {
    const { fetch, calls } = fakeFetch(json(201, { sid: "SM123", status: "accepted" }));
    const channel = createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch, idempotencyCache: new Map() });

    const result = await channel.send(message({ statusCallbackUrl: "https://autofix.vitalos.co.uk/api/webhooks/twilio/status" }));

    expect(result).toEqual({ ok: true, providerMessageId: "SM123", status: "queued" });
    expect(channel).toMatchObject({ kind: "sms", mode: "live" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(header(calls[0], "authorization")).toBe(`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`);
    expect(header(calls[0], "content-type")).toBe("application/x-www-form-urlencoded");
    expect(formOf(calls[0])).toEqual({
      To: "+447700900123",
      MessagingServiceSid: messagingServiceSid,
      Body: "Hi Sam, your MOT is due. Reply STOP to opt out.",
      StatusCallback: "https://autofix.vitalos.co.uk/api/webhooks/twilio/status",
    });
    expect(String(calls[0]?.init.body)).toContain("To=%2B447700900123");
  });

  it("sends a garage's alphanumeric sender as From instead of the Messaging Service", async () => {
    const { fetch, calls } = fakeFetch(json(201, { sid: "SM124", status: "queued" }));
    const channel = createTwilioSmsChannel({
      accountSid,
      authToken,
      messagingServiceSid,
      statusCallbackUrl: "https://default.test/api/webhooks/twilio/status",
      fetch,
      idempotencyCache: new Map(),
    });

    await channel.send(message({ senderId: "HartleyRd" }));

    const form = formOf(calls[0]);
    expect(form.From).toBe("HartleyRd");
    expect(form.MessagingServiceSid).toBeUndefined();
    expect(form.StatusCallback).toBe("https://default.test/api/webhooks/twilio/status");
  });

  it("falls back to a configured From number", async () => {
    const { fetch, calls } = fakeFetch(json(201, { sid: "SM125", status: "queued" }));
    await createTwilioSmsChannel({ accountSid, authToken, from: "+15005550006", fetch, idempotencyCache: new Map() }).send(message());
    expect(formOf(calls[0])).toMatchObject({ From: "+15005550006" });
    expect(formOf(calls[0]).StatusCallback).toBeUndefined();
  });

  it.each(["HartleyRoadGarage", "", "12345", "Hartley'Rd", "Hartley+Rd"])("refuses the sender id %j without calling Twilio", async (senderId) => {
    const { fetch, fn } = fakeFetch();
    const result = await createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch }).send(message({ senderId }));
    expect(result).toMatchObject({ ok: false, code: "configuration_required", retryable: false, providerCode: "invalid_sender_id" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("fails closed without a sender or credentials", async () => {
    const { fetch, fn } = fakeFetch();
    expect(await createTwilioSmsChannel({ accountSid, authToken, fetch }).send(message())).toMatchObject({ code: "configuration_required" });
    expect(await createTwilioSmsChannel({ accountSid: "", authToken, messagingServiceSid, fetch }).send(message())).toMatchObject({ code: "configuration_required" });
    expect(await createTwilioSmsChannel({ accountSid, authToken: " ", messagingServiceSid, fetch }).send(message())).toMatchObject({ code: "configuration_required" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a recipient that is not E.164 and over-long bodies before calling Twilio", async () => {
    const { fetch, fn } = fakeFetch();
    const channel = createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch });
    expect(await channel.send(message({ to: "07700 900123" }))).toMatchObject({ ok: false, code: "invalid_recipient", retryable: false });
    expect(await channel.send(message({ body: "x".repeat(1601) }))).toMatchObject({ ok: false, code: "provider_error", providerCode: "body_too_long" });
    expect(await channel.send(message({ body: "  " }))).toMatchObject({ ok: false, code: "provider_error", providerCode: "body_empty" });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each<[string, Response, Partial<SendResult>]>([
    ["21211 invalid To", json(400, { code: 21211, message: "Invalid 'To' Phone Number", status: 400 }), { code: "invalid_recipient", retryable: false, providerCode: 21211 }],
    ["21614 not a mobile", json(400, { code: 21614, status: 400 }), { code: "invalid_recipient", retryable: false, providerCode: 21614 }],
    ["21612 cannot route", json(400, { code: 21612, status: 400 }), { code: "invalid_recipient", retryable: false }],
    ["21610 unsubscribed", json(400, { code: 21610, status: 400 }), { code: "opted_out", retryable: false, providerCode: 21610 }],
    ["20003 bad credentials", json(401, { code: 20003, status: 401 }), { code: "configuration_required", retryable: false }],
    ["21408 region permission", json(400, { code: 21408, status: 400 }), { code: "configuration_required", retryable: false }],
    ["429 concurrency", json(429, { code: 20429, status: 429 }, { "Retry-After": "30" }), { code: "rate_limited", retryable: true, retryAfterSeconds: 30 }],
    ["429 without a code", new Response("Too Many Requests", { status: 429 }), { code: "rate_limited", retryable: true, providerCode: 429 }],
    ["503 unavailable", json(503, { status: 503 }), { code: "provider_error", retryable: true, providerCode: 503 }],
    ["400 other", json(400, { code: 21617, status: 400 }), { code: "provider_error", retryable: false, providerCode: 21617 }],
  ])("maps %s", async (_label, response, expected) => {
    const { fetch } = fakeFetch(response);
    const result = await createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch }).send(message());
    expect(result).toMatchObject({ ok: false, ...expected });
  });

  it("never puts Twilio's error text, the recipient or the token in a failure", async () => {
    const { fetch } = fakeFetch(json(400, { code: 21211, message: "The 'To' number +447700900123 is not valid", status: 400 }));
    const result = await createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch }).send(message());
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("447700900123");
    expect(serialised).not.toContain(authToken);
  });

  it("reports a timeout as ambiguous and not retryable (Twilio may have accepted it)", async () => {
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    const result = await createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch: hanging as unknown as typeof fetch, timeoutMs: 5 }).send(message());
    expect(result).toEqual({ ok: false, code: "provider_error", retryable: false, providerCode: "timeout", ambiguous: true });
  });

  it("treats a connection that never opened as safe to retry", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const { fetch } = fakeFetch(refused, reset);
    const channel = createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch });
    expect(await channel.send(message())).toEqual({ ok: false, code: "provider_error", retryable: true, providerCode: "network" });
    expect(await channel.send(message())).toEqual({ ok: false, code: "provider_error", retryable: false, providerCode: "network", ambiguous: true });
  });

  it("does not send the same idempotency key twice from one process, but retries after a failure", async () => {
    const { fetch, fn } = fakeFetch(json(503, { status: 503 }), json(201, { sid: "SM200", status: "queued" }));
    const channel = createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch, idempotencyCache: new Map() });
    const once = message();

    expect(await channel.send(once)).toMatchObject({ ok: false, retryable: true });
    expect(await channel.send(once)).toEqual({ ok: true, providerMessageId: "SM200", status: "queued" });
    expect(await channel.send(once)).toEqual({ ok: true, providerMessageId: "SM200", status: "queued" });
    expect(fn).toHaveBeenCalledTimes(2);

    // Same key from another garage is a different message.
    await channel.send({ ...once, garageId: "22222222-2222-4222-8222-222222222222" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("flags a 2xx without a SID as ambiguous", async () => {
    const { fetch } = fakeFetch(json(201, { status: "queued" }));
    const result = await createTwilioSmsChannel({ accountSid, authToken, messagingServiceSid, fetch, idempotencyCache: new Map() }).send(message());
    expect(result).toMatchObject({ ok: false, code: "provider_error", ambiguous: true });
  });
});

describe("Twilio WhatsApp adapter", () => {
  it("uses whatsapp: addressing for To and From", async () => {
    const { fetch, calls } = fakeFetch(json(201, { sid: "SM300", status: "queued" }));
    const channel = createTwilioWhatsAppChannel({ accountSid, authToken, whatsappFrom: "+447700900999", fetch, idempotencyCache: new Map() });

    const result = await channel.send(message({ statusCallbackUrl: "https://autofix.vitalos.co.uk/api/webhooks/twilio/status" }));

    expect(result).toEqual({ ok: true, providerMessageId: "SM300", status: "queued" });
    expect(channel).toMatchObject({ kind: "whatsapp", mode: "live" });
    expect(calls[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
    expect(header(calls[0], "authorization")).toBe(`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`);
    expect(formOf(calls[0])).toEqual({
      To: "whatsapp:+447700900123",
      From: "whatsapp:+447700900999",
      Body: "Hi Sam, your MOT is due. Reply STOP to opt out.",
      StatusCallback: "https://autofix.vitalos.co.uk/api/webhooks/twilio/status",
    });
  });

  it("accepts prefixed addresses without doubling the prefix", async () => {
    const { fetch, calls } = fakeFetch(json(201, { sid: "SM301", status: "queued" }));
    await createTwilioWhatsAppChannel({ accountSid, authToken, whatsappFrom: "whatsapp:+447700900999", fetch, idempotencyCache: new Map() }).send(
      message({ to: "whatsapp:+447700900123" }),
    );
    expect(formOf(calls[0])).toMatchObject({ To: "whatsapp:+447700900123", From: "whatsapp:+447700900999" });
  });

  it("sends an approved template with ContentSid and ContentVariables instead of Body", async () => {
    const { fetch, calls } = fakeFetch(json(201, { sid: "SM302", status: "accepted" }));
    const channel = createTwilioWhatsAppChannel({ accountSid, authToken, whatsappFrom: "+447700900999", messagingServiceSid, fetch, idempotencyCache: new Map() });

    await channel.send(message({ body: "", whatsappTemplate: { contentSid, variables: { "1": "Sam", "2": "14 Nov" } } }));

    const form = formOf(calls[0]);
    expect(form).toMatchObject({ ContentSid: contentSid, MessagingServiceSid: messagingServiceSid, From: "whatsapp:+447700900999" });
    expect(JSON.parse(form.ContentVariables ?? "{}")).toEqual({ "1": "Sam", "2": "14 Nov" });
    expect(form.Body).toBeUndefined();
  });

  it("fails closed on a bad sender or content SID", async () => {
    const { fetch, fn } = fakeFetch();
    expect(await createTwilioWhatsAppChannel({ accountSid, authToken, whatsappFrom: "", fetch }).send(message())).toMatchObject({
      code: "configuration_required",
    });
    expect(
      await createTwilioWhatsAppChannel({ accountSid, authToken, whatsappFrom: "+447700900999", fetch }).send(message({ whatsappTemplate: { contentSid: "HX123" } })),
    ).toMatchObject({ code: "configuration_required", providerCode: "invalid_content_sid" });
    expect(await createTwilioWhatsAppChannel({ accountSid, authToken, whatsappFrom: "+447700900999", fetch }).send(message({ to: "not-a-number" }))).toMatchObject({
      code: "invalid_recipient",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("maps WhatsApp errors", async () => {
    const { fetch } = fakeFetch(json(400, { code: 21610, status: 400 }), json(400, { code: 63007, status: 400 }));
    const channel = createTwilioWhatsAppChannel({ accountSid, authToken, whatsappFrom: "+447700900999", fetch });
    expect(await channel.send(message())).toMatchObject({ code: "opted_out" });
    expect(await channel.send(message())).toMatchObject({ code: "configuration_required", providerCode: 63007 });
  });
});

describe("mapTwilioError", () => {
  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(mapTwilioError(429, null, "12")).toMatchObject({ code: "rate_limited", retryAfterSeconds: 12 });
    const inOneMinute = new Date(Date.now() + 60_000).toUTCString();
    const result = mapTwilioError(429, null, inOneMinute);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(58);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(61);
    }
    expect(mapTwilioError(429, null, "soon")).not.toHaveProperty("retryAfterSeconds");
  });
});

describe("verifyTwilioSignature", () => {
  // Worked example from https://www.twilio.com/docs/usage/security.
  const docsUrl = "https://example.com/myapp.php?foo=1&bar=2";
  const docsParams = { CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" };
  const docsToken = "12345";
  const docsSignature = "L/OH5YylLD5NRKLltdqwSvS0BnU=";

  it("accepts Twilio's documented example", () => {
    expect(verifyTwilioSignature({ url: docsUrl, params: docsParams, signature: docsSignature, authToken: docsToken })).toBe(true);
    expect(computeTwilioSignature(docsUrl, docsParams, docsToken)).toBe(docsSignature);
  });

  it("accepts the positional form from ARCHITECTURE.md", () => {
    expect(verifyTwilioSignature(docsUrl, docsParams, docsSignature, docsToken)).toBe(true);
  });

  // An independent vector built here from the documented algorithm: URL, then
  // each POST param name+value sorted by name, no delimiters, HMAC-SHA1 with
  // the auth token, Base64.
  const url = "https://hartley-road.autofix.vitalos.co.uk/api/webhooks/twilio/sms";
  const params = {
    To: "+447700900999",
    From: "+447700900123",
    Body: "STOP",
    MessageSid: "SM0123456789abcdef0123456789abcdef",
    AccountSid: accountSid,
    NumMedia: "0",
  };
  const expected = createHmac("sha1", authToken)
    .update(`${url}AccountSid${accountSid}BodySTOPFrom+447700900123MessageSidSM0123456789abcdef0123456789abcdefNumMedia0To+447700900999`)
    .digest("base64");

  it("accepts a known-good vector computed from the documented algorithm", () => {
    expect(verifyTwilioSignature({ url, params, signature: expected, authToken })).toBe(true);
    expect(verifyTwilioSignature({ url, params: new URLSearchParams(params), signature: expected, authToken })).toBe(true);
  });

  it("verifies the raw webhook body after parseTwilioForm", () => {
    const rawBody = new URLSearchParams(params).toString();
    expect(verifyTwilioSignature({ url, params: parseTwilioForm(rawBody), signature: expected, authToken })).toBe(true);
  });

  it("rejects a tampered parameter, an extra parameter, the wrong URL or the wrong token", () => {
    expect(verifyTwilioSignature({ url, params: { ...params, Body: "START" }, signature: expected, authToken })).toBe(false);
    expect(verifyTwilioSignature({ url, params: { ...params, Extra: "1" }, signature: expected, authToken })).toBe(false);
    expect(verifyTwilioSignature({ url: `${url}?garage=other`, params, signature: expected, authToken })).toBe(false);
    expect(verifyTwilioSignature({ url: url.replace("hartley-road", "other-garage"), params, signature: expected, authToken })).toBe(false);
    expect(verifyTwilioSignature({ url, params, signature: expected, authToken: `${authToken}x` })).toBe(false);
  });

  it("rejects missing or malformed signatures", () => {
    expect(verifyTwilioSignature({ url, params, signature: undefined, authToken })).toBe(false);
    expect(verifyTwilioSignature({ url, params, signature: "", authToken })).toBe(false);
    expect(verifyTwilioSignature({ url, params, signature: "short", authToken })).toBe(false);
    expect(verifyTwilioSignature({ url, params, signature: expected, authToken: "" })).toBe(false);
  });

  it("accepts a signature made with or without the default port", () => {
    const withPort = "https://hartley-road.autofix.vitalos.co.uk:443/api/webhooks/twilio/sms";
    const signedWithPort = computeTwilioSignature(withPort, params, authToken);
    expect(verifyTwilioSignature({ url, params, signature: signedWithPort, authToken })).toBe(true);
    expect(verifyTwilioSignature({ url: withPort, params, signature: expected, authToken })).toBe(true);
    // A non-default port is never dropped.
    const otherPort = computeTwilioSignature("https://hartley-road.autofix.vitalos.co.uk:8443/api/webhooks/twilio/sms", params, authToken);
    expect(verifyTwilioSignature({ url, params, signature: otherPort, authToken })).toBe(false);
  });

  it("signs repeated keys with each value in sorted order", () => {
    const repeated = new URLSearchParams([["MediaUrl", "b"], ["MediaUrl", "a"], ["Body", "x"]]);
    const signature = createHmac("sha1", authToken).update(`${url}BodyxMediaUrlaMediaUrlb`).digest("base64");
    expect(verifyTwilioSignature({ url, params: repeated, signature, authToken })).toBe(true);
    expect(verifyTwilioSignature({ url, params: { Body: "x", MediaUrl: ["b", "a"] }, signature, authToken })).toBe(true);
  });
});

describe("parseTwilioForm", () => {
  it("decodes form encoding, keeps the first value of a repeated key and is safe with __proto__", () => {
    const parsed = parseTwilioForm("Body=Stop+please&From=%2B447700900123&Body=second&__proto__=x");
    expect(parsed.Body).toBe("Stop please");
    expect(parsed.From).toBe("+447700900123");
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
  });
});

describe("status mapping", () => {
  it.each([
    ["accepted", "queued"],
    ["scheduled", "queued"],
    ["queued", "queued"],
    ["sending", "queued"],
    ["sent", "sent"],
    ["delivered", "delivered"],
    ["read", "delivered"],
    ["undelivered", "failed"],
    ["failed", "failed"],
    ["canceled", "failed"],
    ["SENT", "sent"],
    ["something-new", "queued"],
    [undefined, "queued"],
  ])("%s -> %s", (raw, expected) => {
    expect(mapTwilioStatus(raw)).toBe(expected);
  });

  it("only moves a status forward when callbacks arrive out of order", () => {
    expect(isLaterStatus(null, "queued")).toBe(true);
    expect(isLaterStatus("queued", "sent")).toBe(true);
    expect(isLaterStatus("sent", "delivered")).toBe(true);
    expect(isLaterStatus("sent", "failed")).toBe(true);
    expect(isLaterStatus("delivered", "sent")).toBe(false);
    expect(isLaterStatus("delivered", "failed")).toBe(false);
    expect(isLaterStatus("failed", "delivered")).toBe(false);
    expect(isLaterStatus("sent", "queued")).toBe(false);
    expect(isLaterStatus("sent", "sent")).toBe(false);
  });

  it("parses a status callback, including the WhatsApp outside-window error", () => {
    expect(
      parseTwilioStatusCallback({
        MessageSid: "SM1",
        MessageStatus: "undelivered",
        ErrorCode: String(TWILIO_ERROR_WHATSAPP_OUTSIDE_WINDOW),
        To: "whatsapp:+447700900123",
        From: "whatsapp:+447700900999",
      }),
    ).toEqual({ messageSid: "SM1", rawStatus: "undelivered", status: "failed", errorCode: 63016, to: "+447700900123", from: "+447700900999" });
    expect(parseTwilioStatusCallback({ SmsSid: "SM2", SmsStatus: "delivered" })).toMatchObject({ messageSid: "SM2", status: "delivered", errorCode: null });
    expect(parseTwilioStatusCallback({ MessageStatus: "sent" })).toBeNull();
  });
});

describe("parseTwilioInboundMessage", () => {
  it("reads an inbound SMS STOP", () => {
    expect(
      parseTwilioInboundMessage({ MessageSid: "SM9", From: "+447700900123", To: "+447700900999", Body: " stop ", NumMedia: "0" }),
    ).toEqual({ messageSid: "SM9", channel: "sms", from: "+447700900123", to: "+447700900999", body: " stop ", numMedia: 0, intent: "stop" });
  });

  it("reads an inbound WhatsApp message and Twilio's OptOutType", () => {
    expect(
      parseTwilioInboundMessage({ MessageSid: "SM10", From: "whatsapp:+447700900123", To: "whatsapp:+447700900999", Body: "Thanks", OptOutType: "START" }),
    ).toMatchObject({ channel: "whatsapp", from: "+447700900123", to: "+447700900999", intent: "start" });
  });

  it("rejects malformed webhooks", () => {
    expect(parseTwilioInboundMessage({ From: "+447700900123", To: "+447700900999", Body: "Hi" })).toBeNull();
    expect(parseTwilioInboundMessage({ MessageSid: "SM11", From: "anonymous", To: "+447700900999" })).toBeNull();
  });
});
