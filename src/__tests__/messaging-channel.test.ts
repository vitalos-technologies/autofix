import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionalEmailDeliveryError } from "@/lib/email/resend";
import { getChannel, type OutboundMessage } from "@/lib/messaging/channel";
import { getMessagingMode, getMessagingReadiness } from "@/lib/messaging/config";
import { createResendEmailChannel, resendIdempotencyKey } from "@/lib/messaging/email";
import * as messaging from "@/lib/messaging";
import { clearMockOutbox, getMockOutbox } from "@/lib/messaging/mock";

const garageId = "11111111-1111-4111-8111-111111111111";
const accountSid = `AC${"0123456789abcdef".repeat(2)}`;
const authToken = "fake-auth-token-for-tests-only";
const messagingServiceSid = `MG${"fedcba9876543210".repeat(2)}`;

const liveEnv = {
  MESSAGING_MODE: "live",
  TWILIO_ACCOUNT_SID: accountSid,
  TWILIO_AUTH_TOKEN: authToken,
  TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid,
  TWILIO_WHATSAPP_FROM: "whatsapp:+447700900999",
  TWILIO_STATUS_CALLBACK_BASE_URL: "https://autofix.vitalos.co.uk/",
};

let keySequence = 0;
function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  keySequence += 1;
  return { garageId, to: "+447700900123", body: "Hi Sam. Reply STOP to opt out.", idempotencyKey: `channel-test:${keySequence}`, ...overrides };
}

const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ sid: "SMlive1", status: "accepted" }), { status: 201 }));

beforeEach(() => {
  clearMockOutbox();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  // Make sure nothing in the developer's shell turns on real email.
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("MESSAGING_MODE", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getMessagingMode", () => {
  it.each([
    [{}, "mock"],
    [{ MESSAGING_MODE: "mock" }, "mock"],
    [{ MESSAGING_MODE: "LIVE " }, "live"],
    [{ MESSAGING_MODE: "production" }, "mock"],
  ])("%j -> %s", (env, expected) => {
    expect(getMessagingMode(env)).toBe(expected);
  });
});

describe("mock channels", () => {
  it("are the default and never call the network", async () => {
    for (const kind of ["sms", "whatsapp", "email"] as const) {
      const channel = getChannel(kind, {});
      expect(channel).toMatchObject({ kind, mode: "mock" });
    }
    await getChannel("sms", {}).send(message());
    await getChannel("whatsapp", {}).send(message({ to: "whatsapp:+447700900124" }));
    await getChannel("email", {}).send(message({ to: "sam@example.com", subject: "Your MOT", html: "<p>Hi</p>" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("are used even with live credentials present unless MESSAGING_MODE=live", async () => {
    const channel = getChannel("sms", { ...liveEnv, MESSAGING_MODE: "mock" });
    expect(channel.mode).toBe("mock");
    await channel.send(message());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("record every send in the shared outbox", async () => {
    const sms = await getChannel("sms", {}).send(message({ senderId: "HartleyRd", statusCallbackUrl: "https://x.test/status" }));
    const whatsapp = await getChannel("whatsapp", {}).send(message({ to: "whatsapp:+447700900124" }));
    const email = await getChannel("email", {}).send(message({ to: "sam@example.com", subject: "Your MOT" }));

    expect(sms).toEqual({ ok: true, providerMessageId: "SMmock00000001", status: "queued" });
    expect(whatsapp).toMatchObject({ ok: true, providerMessageId: "SMmock00000002" });
    expect(email).toEqual({ ok: true, providerMessageId: "mock_email_00000003", status: "sent" });

    const outbox = getMockOutbox();
    expect(outbox.map((entry) => [entry.kind, entry.to])).toEqual([
      ["sms", "+447700900123"],
      ["whatsapp", "+447700900124"],
      ["email", "sam@example.com"],
    ]);
    expect(outbox[0]).toMatchObject({ garageId, senderId: "HartleyRd", statusCallbackUrl: "https://x.test/status", body: "Hi Sam. Reply STOP to opt out." });
    expect(outbox[2]).toMatchObject({ subject: "Your MOT" });
    expect(outbox[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("returns a copy of the outbox and clears it", async () => {
    await getChannel("sms", {}).send(message());
    const copy = getMockOutbox();
    copy.pop();
    expect(getMockOutbox()).toHaveLength(1);
    clearMockOutbox();
    expect(getMockOutbox()).toEqual([]);
  });

  it("shares one outbox across channel instances and records an idempotency key once", async () => {
    const once = message();
    const first = await getChannel("sms", {}).send(once);
    const second = await getChannel("sms", {}).send(once);
    expect(second).toEqual(first);
    expect(getMockOutbox()).toHaveLength(1);

    // Same key on another channel or garage is a different message.
    await getChannel("whatsapp", {}).send(once);
    await getChannel("sms", {}).send({ ...once, garageId: "22222222-2222-4222-8222-222222222222" });
    expect(getMockOutbox()).toHaveLength(3);
  });

  it("validates like the live adapters", async () => {
    expect(await getChannel("sms", {}).send(message({ to: "07700 900123" }))).toMatchObject({ ok: false, code: "invalid_recipient" });
    expect(await getChannel("sms", {}).send(message({ senderId: "Hartley Road Garage" }))).toMatchObject({ ok: false, code: "configuration_required" });
    expect(await getChannel("sms", {}).send(message({ body: "" }))).toMatchObject({ ok: false, code: "provider_error", providerCode: "body_empty" });
    expect(await getChannel("email", {}).send(message({ to: "not-an-email" }))).toMatchObject({ ok: false, code: "invalid_recipient" });
    expect(
      await getChannel("whatsapp", {}).send(message({ body: "", whatsappTemplate: { contentSid: `HX${"b".repeat(32)}`, variables: { "1": "Sam" } } })),
    ).toMatchObject({ ok: true });
    expect(getMockOutbox()).toHaveLength(1);
  });

  it.each([
    ["+15005550001", "invalid_recipient", 21211],
    ["+15005550002", "invalid_recipient", 21612],
    ["+15005550003", "configuration_required", 21408],
    ["+15005550004", "opted_out", 21610],
    ["+15005550009", "invalid_recipient", 21614],
  ])("mirrors Twilio's magic test number %s", async (to, code, providerCode) => {
    expect(await getChannel("sms", {}).send(message({ to }))).toEqual({ ok: false, code, retryable: false, providerCode });
    expect(getMockOutbox()).toEqual([]);
  });
});

describe("getChannel in live mode", () => {
  it("fails closed with configuration_required when credentials are missing, without throwing or calling out", async () => {
    for (const kind of ["sms", "whatsapp", "email"] as const) {
      const channel = getChannel(kind, { MESSAGING_MODE: "live" });
      expect(channel).toMatchObject({ kind, mode: "live" });
      const result = await channel.send(message({ to: kind === "email" ? "sam@example.com" : "+447700900123" }));
      expect(result).toEqual({ ok: false, code: "configuration_required", retryable: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getMockOutbox()).toEqual([]);
  });

  it("treats malformed identifiers as missing", async () => {
    const result = await getChannel("sms", { ...liveEnv, TWILIO_ACCOUNT_SID: "not-a-sid" }).send(message());
    expect(result).toMatchObject({ code: "configuration_required" });
    expect(await getChannel("sms", { ...liveEnv, TWILIO_MESSAGING_SERVICE_SID: "MG123" }).send(message())).toMatchObject({ code: "configuration_required" });
    expect(await getChannel("whatsapp", { ...liveEnv, TWILIO_WHATSAPP_FROM: "07700900999" }).send(message())).toMatchObject({ code: "configuration_required" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends SMS through Twilio with the default status callback when configured", async () => {
    const channel = getChannel("sms", liveEnv);
    expect(channel.mode).toBe("live");
    const result = await channel.send(message());
    expect(result).toEqual({ ok: true, providerMessageId: "SMlive1", status: "queued" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toMatchObject({
      MessagingServiceSid: messagingServiceSid,
      StatusCallback: "https://autofix.vitalos.co.uk/api/webhooks/twilio/status",
    });
    expect(getMockOutbox()).toEqual([]);
  });

  it("sends WhatsApp from the configured sender", async () => {
    await getChannel("whatsapp", liveEnv).send(message());
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toMatchObject({ From: "whatsapp:+447700900999", To: "whatsapp:+447700900123" });
  });

  it("ignores a status callback base that is not https", async () => {
    await getChannel("sms", { ...liveEnv, TWILIO_STATUS_CALLBACK_BASE_URL: "http://localhost:3000" }).send(message());
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has("StatusCallback")).toBe(false);
  });
});

describe("getMessagingReadiness", () => {
  it("reports mock mode", () => {
    expect(getMessagingReadiness({})).toEqual({
      mode: "mock",
      channels: { sms: "mock", whatsapp: "mock", email: "mock" },
      missing: [],
      statusCallbacks: "not_configured",
    });
  });

  it("names what is missing in live mode without exposing values", () => {
    const readiness = getMessagingReadiness({ MESSAGING_MODE: "live", TWILIO_AUTH_TOKEN: authToken });
    expect(readiness.channels).toEqual({ sms: "configuration_required", whatsapp: "configuration_required", email: "configuration_required" });
    expect(readiness.missing).toEqual(["TWILIO_ACCOUNT_SID", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_WHATSAPP_FROM", "RESEND_*"]);
    expect(JSON.stringify(readiness)).not.toContain(authToken);
  });

  it("reports Twilio channels ready when configured", () => {
    const readiness = getMessagingReadiness(liveEnv);
    expect(readiness.channels).toMatchObject({ sms: "ready", whatsapp: "ready" });
    expect(readiness.statusCallbacks).toBe("configured");
    expect(JSON.stringify(readiness)).not.toContain(authToken);
    expect(JSON.stringify(readiness)).not.toContain(accountSid);
  });
});

describe("Resend email channel", () => {
  const sent = { data: { id: "re_123" }, error: null, headers: null };

  it("is a mock in mock mode", async () => {
    const send = vi.fn();
    const channel = createResendEmailChannel({ mode: "mock", send });
    expect(channel.mode).toBe("mock");
    await channel.send(message({ to: "sam@example.com" }));
    expect(send).not.toHaveBeenCalled();
    expect(getMockOutbox()).toHaveLength(1);
  });

  it("defaults to MESSAGING_MODE", () => {
    expect(createResendEmailChannel().mode).toBe("mock");
    vi.stubEnv("MESSAGING_MODE", "live");
    expect(createResendEmailChannel().mode).toBe("live");
  });

  it("wraps sendTransactionalEmail with a garage-scoped idempotency key", async () => {
    const send = vi.fn(async () => sent);
    const channel = createResendEmailChannel({ mode: "live", send: send as never });
    const result = await channel.send(message({ to: "sam@example.com", subject: "Booking confirmed", body: "See you Tuesday.", html: "<p>See you Tuesday.</p>", idempotencyKey: "booking:HRG-1042" }));

    expect(result).toEqual({ ok: true, providerMessageId: "re_123", status: "sent" });
    expect(send).toHaveBeenCalledWith({
      to: "sam@example.com",
      subject: "Booking confirmed",
      text: "See you Tuesday.",
      html: "<p>See you Tuesday.</p>",
      idempotencyKey: `autofix:${garageId}:booking:HRG-1042`,
      tags: [{ name: "garage_id", value: garageId }],
    });
  });

  it("uses the first line of the body when there is no subject", async () => {
    const send = vi.fn(async () => sent);
    await createResendEmailChannel({ mode: "live", send: send as never }).send(message({ to: "sam@example.com", subject: undefined, body: "Your MOT is due\nMore text" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: "Your MOT is due" }));
  });

  it("rejects a bad address without calling Resend", async () => {
    const send = vi.fn();
    expect(await createResendEmailChannel({ mode: "live", send }).send(message({ to: "+447700900123" }))).toMatchObject({ ok: false, code: "invalid_recipient" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [new TransactionalEmailDeliveryError("rejected", "email_not_configured", false), { code: "configuration_required", retryable: false }],
    [new TransactionalEmailDeliveryError("rejected", "invalid_recipient_or_sender", false), { code: "invalid_recipient", retryable: false }],
    [new TransactionalEmailDeliveryError("rejected", "rate_limit_exceeded", true), { code: "rate_limited", retryable: true }],
    [new TransactionalEmailDeliveryError("ambiguous", "internal_server_error", true), { code: "provider_error", retryable: true, ambiguous: true }],
    [new TransactionalEmailDeliveryError("rejected", "validation_error", false), { code: "provider_error", retryable: false }],
    [new TypeError("fetch failed"), { code: "provider_error", retryable: true, providerCode: "network", ambiguous: true }],
  ])("maps %s", async (error, expected) => {
    const send = vi.fn(async () => {
      throw error;
    });
    expect(await createResendEmailChannel({ mode: "live", send }).send(message({ to: "sam@example.com" }))).toMatchObject({ ok: false, ...expected });
  });

  it("keeps long idempotency keys within Resend's 256-character limit", () => {
    const key = resendIdempotencyKey(garageId, "x".repeat(400));
    expect(key.length).toBeLessThanOrEqual(256);
    expect(key).toBe(resendIdempotencyKey(garageId, "x".repeat(400)));
    expect(key).not.toBe(resendIdempotencyKey("22222222-2222-4222-8222-222222222222", "x".repeat(400)));
  });
});

describe("barrel", () => {
  it("exposes the public API", () => {
    for (const name of [
      "getChannel",
      "getMockOutbox",
      "clearMockOutbox",
      "createTwilioSmsChannel",
      "createTwilioWhatsAppChannel",
      "verifyTwilioSignature",
      "parseTwilioForm",
      "mapTwilioStatus",
      "createResendEmailChannel",
      "renderTemplate",
      "withOptOut",
      "smsSegments",
      "DEFAULT_TEMPLATES",
      "isWithinSendWindow",
      "nextSendWindow",
      "classifyInbound",
      "toE164UK",
      "maskPhone",
    ]) {
      expect(messaging).toHaveProperty(name);
    }
  });
});
