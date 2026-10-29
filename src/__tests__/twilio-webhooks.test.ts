import { describe, expect, it, vi } from "vitest";
import { createJobLogger } from "@/lib/jobs/log";
import type { DeliveryStatus } from "@/lib/messaging/channel";
import { computeTwilioSignature } from "@/lib/messaging/twilio";
import { createSupabaseTwilioWebhookRepo } from "@/lib/messaging/twilio-webhook-repository";
import { platformVoiceNumbers } from "@/lib/calls/platform-line";
import { handleTwilioWebhook, type CallRecord, type InboundMessageRow, type PlatformCallRecord, type TwilioWebhookKind, type TwilioWebhookRepo } from "@/lib/messaging/twilio-webhooks";
import { twilioWebhookUrl } from "@/lib/messaging/webhook-request";
import { createFakeSupabase, filterValue } from "./support/fake-supabase";

// POST /api/webhooks/twilio/{sms,whatsapp,status,voice} (P3.8): the signature
// on the raw body (good, bad, replayed), the public URL behind proxies,
// routing by provisioned number, STOP/START/HELP, delivery-status ordering
// and the voice log.

const AUTH_TOKEN = "twilio-test-auth-token-0123456789";
const BASE = "https://autofix.vitalos.co.uk";
const ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL: BASE };
const GARAGE = "a0000000-0000-4000-8000-00000000000a";
const GARAGE_NUMBER = "+447700100200";
const CUSTOMER = "+447700900123";
/** Autofix's own line (A420). */
const PLATFORM_NUMBER = "+441146974393";

function signedRequest(kind: TwilioWebhookKind, params: Record<string, string>, options: { signWith?: string; url?: string; headers?: Record<string, string>; requestUrl?: string; query?: string } = {}) {
  const body = new URLSearchParams(params).toString();
  const path = `/api/webhooks/twilio/${kind}${options.query ?? ""}`;
  const signature = computeTwilioSignature(options.url ?? `${BASE}${path}`, new URLSearchParams(body), options.signWith ?? AUTH_TOKEN);
  return new Request(options.requestUrl ?? `http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature, ...options.headers },
    body,
  });
}

type Customer = { garageId: string; phone: string; consent: boolean; optedOut: boolean };

type StoredCall = CallRecord & { id: string; dialStatus?: string; voicemail?: { url: string; durationSeconds: number | null } };
type StoredPlatformCall = PlatformCallRecord & { voicemail?: { url: string; durationSeconds: number | null } };

function memoryRepo(options: { routed?: boolean; customers?: Customer[]; messageStatus?: Record<string, string>; reminderStatus?: Record<string, string>; recentGarages?: string[]; dialTarget?: string; recentCaller?: boolean } = {}) {
  const events = new Map<string, string>();
  const customers = options.customers ?? [{ garageId: GARAGE, phone: CUSTOMER, consent: true, optedOut: false }];
  const messageStatus = { ...options.messageStatus };
  const reminderStatus = { ...options.reminderStatus };
  const state = {
    inbound: [] as InboundMessageRow[],
    keywords: [] as Array<{ garageId: string; phone: string; intent: string; changed: number }>,
    calls: new Map<string, StoredCall>(),
    platformCalls: new Map<string, StoredPlatformCall>(),
    replies: [] as string[],
    textBacks: [] as string[],
    finished: [] as Array<{ key: string; status: string; outcome?: string | null }>,
    messageStatus,
    reminderStatus,
  };
  const repo: TwilioWebhookRepo = {
    async claimEvent(key) {
      const current = events.get(key);
      if (current && current !== "failed") return false;
      events.set(key, "processing");
      return true;
    },
    async finishEvent(key, status, outcome) {
      events.set(key, status);
      state.finished.push({ key, status, outcome });
    },
    async findGarageByNumber(number) {
      return options.routed === false || number !== GARAGE_NUMBER ? null : { garageId: GARAGE, garageName: "Hartley Road & Sons", purpose: "forwarding" };
    },
    async findCustomerId(garageId, phone) {
      return customers.some((customer) => customer.garageId === garageId && customer.phone === phone) ? "customer-1" : null;
    },
    async insertInboundMessage(row) {
      if (state.inbound.some((message) => message.providerMessageId === row.providerMessageId)) return null;
      state.inbound.push(row);
      return { id: `message-${state.inbound.length}` };
    },
    async applyKeyword(garageId, phone, intent) {
      let changed = 0;
      for (const customer of customers) {
        if (customer.garageId !== garageId || customer.phone !== phone) continue;
        if (intent === "stop" && !customer.optedOut) {
          customer.optedOut = true;
          changed += 1;
        }
        if (intent === "start" && customer.optedOut && customer.consent) {
          customer.optedOut = false;
          changed += 1;
        }
      }
      state.keywords.push({ garageId, phone, intent, changed });
      return { customers: changed, cancelled: 0, unchanged: 0 };
    },
    async garagesThatMessaged() {
      return options.recentGarages ?? [];
    },
    async applyDeliveryStatus(sid, status: DeliveryStatus) {
      const rank: Record<string, number> = { sending: 0, queued: 0, sent: 1, delivered: 2, failed: 2 };
      let messages = 0;
      const current = messageStatus[sid];
      if (current && current !== "delivered" && current !== "failed" && rank[status]! > rank[current]!) {
        messageStatus[sid] = status;
        messages = 1;
      }
      return { messages, reminders: 0 };
    },
    async recordCall(call) {
      const existing = state.calls.get(call.callSid);
      const id = existing?.id ?? `call-${call.callSid}`;
      // Like the database: the first row keeps its missed flag; later callbacks move status and duration.
      state.calls.set(call.callSid, existing ? { ...existing, status: call.status, durationSeconds: call.durationSeconds ?? existing.durationSeconds } : { ...call, id });
      return { outcome: existing ? "updated" : "created", callId: id };
    },
    async recordPlatformCall(call) {
      const existing = state.platformCalls.get(call.callSid);
      state.platformCalls.set(call.callSid, existing ? { ...existing, status: call.status, durationSeconds: call.durationSeconds ?? existing.durationSeconds } : call);
      return { outcome: existing ? "updated" : "created" };
    },
    async findDialTarget() {
      return options.dialTarget ?? null;
    },
    async callerRangRecently() {
      return options.recentCaller ?? false;
    },
    async recordDialOutcome(_garageId, callSid, outcome) {
      const existing = state.calls.get(callSid);
      if (!existing) return { callId: null };
      state.calls.set(callSid, { ...existing, dialStatus: outcome.dialStatus, missed: outcome.missed });
      return { callId: existing.id };
    },
    async recordVoicemail(callSid, voicemail) {
      const existing = state.calls.get(callSid);
      if (existing) {
        state.calls.set(callSid, { ...existing, voicemail });
        return true;
      }
      const platform = state.platformCalls.get(callSid);
      if (!platform) return false;
      state.platformCalls.set(callSid, { ...platform, voicemail });
      return true;
    },
    async queueTextBack(_garageId, callId) {
      state.textBacks.push(callId);
    },
    async queueHelpReply(_garageId, messageId) {
      state.replies.push(messageId);
    },
  };
  return { repo, state, customers };
}

const lines: string[] = [];
const log = createJobLogger({}, (_level, line) => lines.push(line));

function deps(repo: TwilioWebhookRepo, extra: Record<string, unknown> = {}) {
  return { repo: () => repo, env: ENV, log, ...extra };
}

const inboundParams = (body: string, sid = "SM00000000000000000000000000000001", extra: Record<string, string> = {}) => ({
  MessageSid: sid,
  AccountSid: "AC00000000000000000000000000000000",
  From: CUSTOMER,
  To: GARAGE_NUMBER,
  Body: body,
  NumMedia: "0",
  ...extra,
});

describe("signature and URL", () => {
  it("accepts Twilio's signature on the raw body and answers with empty TwiML", async () => {
    const { repo, state } = memoryRepo();
    const response = await handleTwilioWebhook(signedRequest("sms", inboundParams("Thanks, see you Tuesday")), "sms", deps(repo));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(state.inbound).toHaveLength(1);
  });

  it("refuses a bad signature, another token's signature, and a tampered body before storing anything", async () => {
    const { repo, state } = memoryRepo();
    const forged = await handleTwilioWebhook(signedRequest("sms", inboundParams("STOP"), { signWith: "someone-elses-token-000000000000" }), "sms", deps(repo));
    expect(forged.status).toBe(403);

    const request = signedRequest("sms", inboundParams("hello"));
    const tampered = new Request(request.url, { method: "POST", headers: request.headers, body: new URLSearchParams(inboundParams("STOP")).toString() });
    expect((await handleTwilioWebhook(tampered, "sms", deps(repo))).status).toBe(403);

    const unsigned = new Request(`${BASE}/api/webhooks/twilio/sms`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "MessageSid=SM1" });
    expect((await handleTwilioWebhook(unsigned, "sms", deps(repo))).status).toBe(403);
    expect(state.inbound).toEqual([]);
    expect(state.finished).toEqual([]);
  });

  it("does a replayed (identical, validly signed) request's work only once", async () => {
    const { repo, state, customers } = memoryRepo();
    const params = inboundParams("STOP");
    expect((await handleTwilioWebhook(signedRequest("sms", params), "sms", deps(repo))).status).toBe(200);
    expect((await handleTwilioWebhook(signedRequest("sms", params), "sms", deps(repo))).status).toBe(200);
    expect(state.inbound).toHaveLength(1);
    expect(state.keywords).toEqual([{ garageId: GARAGE, phone: CUSTOMER, intent: "stop", changed: 1 }]);
    expect(customers[0]!.optedOut).toBe(true);
  });

  it("logs kinds and outcomes only, never numbers or bodies", async () => {
    lines.length = 0;
    const { repo } = memoryRepo();
    await handleTwilioWebhook(signedRequest("sms", inboundParams("My reg is AB12 CDE")), "sms", deps(repo));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "twilio_webhook", kind: "sms", outcome: "stored" });
    for (const secret of [CUSTOMER, GARAGE_NUMBER, "AB12", "My reg"]) expect(lines[0]).not.toContain(secret);
  });

  it("fails closed without TWILIO_AUTH_TOKEN, and refuses other content types", async () => {
    const { repo } = memoryRepo();
    expect((await handleTwilioWebhook(signedRequest("sms", inboundParams("hi")), "sms", { repo: () => repo, env: {}, log })).status).toBe(503);
    const json = new Request(`${BASE}/api/webhooks/twilio/sms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await handleTwilioWebhook(json, "sms", deps(repo))).status).toBe(415);
  });

  it("rebuilds the signed URL from TWILIO_WEBHOOK_BASE_URL, else the forwarded headers, keeping the query", () => {
    const behindProxy = new Request("http://10.0.0.5:3000/api/webhooks/twilio/status?garage=x", {
      method: "POST",
      headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "autofix.vitalos.co.uk, internal", host: "10.0.0.5:3000" },
    });
    expect(twilioWebhookUrl(behindProxy, {})).toBe("https://autofix.vitalos.co.uk/api/webhooks/twilio/status?garage=x");
    expect(twilioWebhookUrl(behindProxy, { TWILIO_WEBHOOK_BASE_URL: "https://hooks.example.com/autofix/" })).toBe("https://hooks.example.com/autofix/api/webhooks/twilio/status?garage=x");
    const direct = new Request("https://autofix.vitalos.co.uk/api/webhooks/twilio/sms", { method: "POST", headers: { host: "autofix.vitalos.co.uk" } });
    expect(twilioWebhookUrl(direct, {})).toBe("https://autofix.vitalos.co.uk/api/webhooks/twilio/sms");
  });

  it("verifies a request signed for the forwarded public URL when no base URL is set", async () => {
    const { repo, state } = memoryRepo();
    const request = signedRequest("sms", inboundParams("hi"), {
      url: "https://autofix.vitalos.co.uk/api/webhooks/twilio/sms",
      requestUrl: "http://10.0.0.5:3000/api/webhooks/twilio/sms",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "autofix.vitalos.co.uk" },
    });
    expect((await handleTwilioWebhook(request, "sms", { repo: () => repo, env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN }, log })).status).toBe(200);
    expect(state.inbound).toHaveLength(1);
  });
});

describe("inbound SMS and WhatsApp", () => {
  it("stores the text for the garage behind the number, with the customer when known", async () => {
    const { repo, state } = memoryRepo();
    await handleTwilioWebhook(signedRequest("whatsapp", inboundParams("Is Tuesday OK?", "SM00000000000000000000000000000002", { From: `whatsapp:${CUSTOMER}`, To: `whatsapp:${GARAGE_NUMBER}` })), "whatsapp", deps(repo));
    expect(state.inbound).toEqual([{ garageId: GARAGE, customerId: "customer-1", channel: "whatsapp", from: CUSTOMER, to: GARAGE_NUMBER, body: "Is Tuesday OK?", providerMessageId: "SM00000000000000000000000000000002" }]);
  });

  it("ignores texts to numbers that are not provisioned, but still honours a STOP for garages that texted the sender", async () => {
    const unrouted = memoryRepo({ routed: false });
    await handleTwilioWebhook(signedRequest("sms", inboundParams("hello")), "sms", deps(unrouted.repo));
    expect(unrouted.state.inbound).toEqual([]);
    expect(unrouted.state.finished).toEqual([{ key: "inbound:SM00000000000000000000000000000001", status: "ignored", outcome: "unrouted" }]);

    const stop = memoryRepo({ routed: false, recentGarages: [GARAGE] });
    await handleTwilioWebhook(signedRequest("sms", inboundParams("Stop")), "sms", deps(stop.repo));
    expect(stop.customers[0]!.optedOut).toBe(true);
    expect(stop.state.finished[0]).toMatchObject({ status: "processed", outcome: "stop_unrouted" });
  });

  it("STOP opts out at once and a second STOP changes nothing; START comes back only with consent", async () => {
    const { repo, state, customers } = memoryRepo({ customers: [
      { garageId: GARAGE, phone: CUSTOMER, consent: true, optedOut: false },
    ] });
    await handleTwilioWebhook(signedRequest("sms", inboundParams("STOP", "SM00000000000000000000000000000011")), "sms", deps(repo));
    await handleTwilioWebhook(signedRequest("sms", inboundParams("stop please", "SM00000000000000000000000000000012")), "sms", deps(repo));
    expect(state.keywords.map((entry) => [entry.intent, entry.changed])).toEqual([["stop", 1], ["stop", 0]]);
    expect(customers[0]!.optedOut).toBe(true);
    await handleTwilioWebhook(signedRequest("sms", inboundParams("START", "SM00000000000000000000000000000013")), "sms", deps(repo));
    expect(customers[0]!.optedOut).toBe(false);
    expect(state.finished.map((entry) => entry.outcome)).toEqual(["stop", "stop", "start"]);

    const noConsent = memoryRepo({ customers: [{ garageId: GARAGE, phone: CUSTOMER, consent: false, optedOut: true }] });
    await handleTwilioWebhook(signedRequest("sms", inboundParams("START")), "sms", deps(noConsent.repo));
    expect(noConsent.customers[0]!.optedOut).toBe(true);
    expect(noConsent.state.finished[0]?.outcome).toBe("start_without_consent");
  });

  it("queues a HELP answer and drains it after the response, unless Twilio already answered", async () => {
    const { repo, state } = memoryRepo();
    const tasks: Array<() => Promise<unknown>> = [];
    const drainQueued = vi.fn(async () => undefined);
    await handleTwilioWebhook(signedRequest("sms", inboundParams("HELP")), "sms", deps(repo, { afterResponse: (task: () => Promise<unknown>) => tasks.push(task), drainQueued }));
    expect(state.replies).toEqual(["message-1"]);
    expect(drainQueued).not.toHaveBeenCalled();
    await tasks[0]!();
    expect(drainQueued).toHaveBeenCalledExactlyOnceWith(["messages.reply"]);

    const advanced = memoryRepo();
    await handleTwilioWebhook(signedRequest("sms", inboundParams("HELP", "SM00000000000000000000000000000021", { OptOutType: "HELP" })), "sms", deps(advanced.repo));
    expect(advanced.state.replies).toEqual([]);
  });

  it("answers 500 when the work fails, and processes the same event again on Twilio's retry", async () => {
    const { repo, state } = memoryRepo();
    const insert = repo.insertInboundMessage.bind(repo);
    let failures = 1;
    repo.insertInboundMessage = async (row) => {
      if (failures-- > 0) throw Object.assign(new Error("connection reset"), { code: "08006" });
      return insert(row);
    };
    expect((await handleTwilioWebhook(signedRequest("sms", inboundParams("hello")), "sms", deps(repo))).status).toBe(500);
    expect(state.finished[0]).toMatchObject({ status: "failed" });
    expect((await handleTwilioWebhook(signedRequest("sms", inboundParams("hello")), "sms", deps(repo))).status).toBe(200);
    expect(state.inbound).toHaveLength(1);
  });
});

describe("delivery status callbacks", () => {
  const statusParams = (status: string, sid = "SMstatus000000000000000000000001", extra: Record<string, string> = {}) => ({ MessageSid: sid, MessageStatus: status, To: CUSTOMER, ...extra });

  it("moves a message forward only, whatever order the callbacks arrive in", async () => {
    const { repo, state } = memoryRepo({ messageStatus: { SMstatus000000000000000000000001: "queued" } });
    for (const status of ["delivered", "sent", "queued"]) {
      expect((await handleTwilioWebhook(signedRequest("status", statusParams(status)), "status", deps(repo))).status).toBe(200);
    }
    expect(state.messageStatus.SMstatus000000000000000000000001).toBe("delivered");
    expect(state.finished.map((entry) => [entry.key, entry.status])).toEqual([
      ["status:SMstatus000000000000000000000001:delivered", "processed"],
      ["status:SMstatus000000000000000000000001:sent", "ignored"],
      ["status:SMstatus000000000000000000000001:queued", "ignored"],
    ]);
  });

  it("applies each status of a message once", async () => {
    const { repo, state } = memoryRepo({ messageStatus: { SMstatus000000000000000000000001: "queued" } });
    await handleTwilioWebhook(signedRequest("status", statusParams("sent")), "status", deps(repo));
    await handleTwilioWebhook(signedRequest("status", statusParams("sent")), "status", deps(repo));
    expect(state.finished).toHaveLength(1);
  });
});

describe("voice (P4.1 missed calls)", () => {
  const CALL = "CA00000000000000000000000000000001";
  const OWN_PHONE = "+441302000101";
  const RECORDING = "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000001";
  const callParams = (status: string, extra: Record<string, string> = {}) => ({ CallSid: CALL, From: CUSTOMER, To: GARAGE_NUMBER, CallStatus: status, Direction: "inbound", ...extra });
  const voiceUrl = (step: string) => `${BASE}/api/webhooks/twilio/voice?step=${step}`;

  function capture() {
    const tasks: Array<() => Promise<unknown>> = [];
    const drainQueued = vi.fn(async () => undefined);
    return { tasks, drainQueued, extra: { afterResponse: (task: () => Promise<unknown>) => tasks.push(task), drainQueued } };
  }

  it("without a phone of its own the garage greets in its name, takes a voicemail and queues the text-back", async () => {
    const { repo, state } = memoryRepo();
    const { tasks, drainQueued, extra } = capture();
    const response = await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo, extra));
    const xml = await response.text();
    expect(xml).toContain("<Say language=\"en-GB\">Sorry, Hartley Road &amp; Sons can&apos;t take your call right now. Please leave a message after the tone and we&apos;ll get back to you.</Say>");
    expect(xml).toContain(`<Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" action="${voiceUrl("recorded")}" method="POST" recordingStatusCallback="${voiceUrl("recording")}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>`);
    expect(xml).not.toMatch(/transcribe/i);
    expect(xml).toMatch(/\/><Say language="en-GB">We didn&apos;t get a message\. Goodbye\.<\/Say><Hangup\/><\/Response>$/);
    expect(state.calls.get(CALL)).toMatchObject({ garageId: GARAGE, from: CUSTOMER, to: GARAGE_NUMBER, status: "ringing", missed: true });
    expect(state.textBacks).toEqual([`call-${CALL}`]);
    // The text-back is drained after the response, not before it.
    expect(drainQueued).not.toHaveBeenCalled();
    await tasks[0]!();
    expect(drainQueued).toHaveBeenCalledExactlyOnceWith(["calls.text_back"]);
  });

  it("rings the garage's own phone first, and only counts the call missed when that fails", async () => {
    const { repo, state } = memoryRepo({ dialTarget: OWN_PHONE });
    const xml = await (await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo))).text();
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" answerOnBridge="true" action="${voiceUrl("dial")}" method="POST"><Number>${OWN_PHONE}</Number></Dial></Response>`);
    expect(state.calls.get(CALL)).toMatchObject({ missed: false });
    expect(state.textBacks).toEqual([]);
  });

  it.each(["no-answer", "busy", "failed", "canceled"])("after a %s dial it takes a voicemail and texts the caller back", async (dialStatus) => {
    const { repo, state } = memoryRepo({ dialTarget: OWN_PHONE });
    await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo));
    const xml = await (await handleTwilioWebhook(signedRequest("voice", callParams("in-progress", { DialCallStatus: dialStatus, DialCallDuration: "0" }), { query: "?step=dial" }), "voice", deps(repo))).text();
    expect(xml).toContain("<Record ");
    expect(state.calls.get(CALL)).toMatchObject({ dialStatus, missed: true });
    expect(state.textBacks).toEqual([`call-${CALL}`]);
  });

  it("an answered dial just hangs up when the garage puts the phone down: not missed, no text", async () => {
    const { repo, state } = memoryRepo({ dialTarget: OWN_PHONE });
    await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo));
    const xml = await (await handleTwilioWebhook(signedRequest("voice", callParams("in-progress", { DialCallStatus: "completed", DialCallDuration: "95" }), { query: "?step=dial" }), "voice", deps(repo))).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(state.calls.get(CALL)).toMatchObject({ dialStatus: "completed", missed: false });
    expect(state.textBacks).toEqual([]);
  });

  it("never rings the garage's phone again for a forward that came back to us", async () => {
    const recent = memoryRepo({ dialTarget: OWN_PHONE, recentCaller: true });
    const xml = await (await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(recent.repo))).text();
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("<Record ");
    expect(recent.state.calls.get(CALL)).toMatchObject({ missed: true });
    expect(recent.state.finished.at(-1)).toMatchObject({ outcome: "call_forward_returned" });

    const forwarded = memoryRepo({ dialTarget: OWN_PHONE });
    const again = await (await handleTwilioWebhook(signedRequest("voice", callParams("ringing", { ForwardedFrom: OWN_PHONE })), "voice", deps(forwarded.repo))).text();
    expect(again).not.toContain("<Dial");
  });

  it("answers Twilio's retry of the first request with the same TwiML, without writing or texting twice", async () => {
    const { repo, state } = memoryRepo();
    const first = await (await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo))).text();
    const retry = await (await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo))).text();
    expect(retry).toBe(first);
    expect(state.textBacks).toHaveLength(1);
    expect(state.finished.filter((entry) => entry.key === `voice:${CALL}:ringing`)).toHaveLength(1);
  });

  it("stores the voicemail link from the recording callback once, and only Twilio recording links", async () => {
    const { repo, state } = memoryRepo();
    await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo));
    const recording = { CallSid: CALL, RecordingSid: "RE00000000000000000000000000000001", RecordingUrl: RECORDING, RecordingStatus: "completed", RecordingDuration: "17" };
    expect((await handleTwilioWebhook(signedRequest("voice", recording, { query: "?step=recording" }), "voice", deps(repo))).status).toBe(200);
    expect(state.calls.get(CALL)?.voicemail).toEqual({ url: RECORDING, durationSeconds: 17 });
    await handleTwilioWebhook(signedRequest("voice", { ...recording, RecordingDuration: "99" }, { query: "?step=recording" }), "voice", deps(repo));
    expect(state.calls.get(CALL)?.voicemail?.durationSeconds).toBe(17);

    const other = memoryRepo();
    await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(other.repo));
    await handleTwilioWebhook(signedRequest("voice", { ...recording, RecordingUrl: "https://evil.example/recording" }, { query: "?step=recording" }), "voice", deps(other.repo));
    await handleTwilioWebhook(signedRequest("voice", { ...recording, RecordingStatus: "absent" }, { query: "?step=recording" }), "voice", deps(other.repo));
    expect(other.state.calls.get(CALL)?.voicemail).toBeUndefined();
  });

  it("thanks the caller after the recording, and records nothing", async () => {
    const { repo, state } = memoryRepo();
    const xml = await (await handleTwilioWebhook(signedRequest("voice", { CallSid: CALL, To: GARAGE_NUMBER, RecordingUrl: RECORDING }, { query: "?step=recorded" }), "voice", deps(repo))).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-GB">Thanks for your message. Goodbye.</Say><Hangup/></Response>');
    expect(state.calls.size).toBe(0);
  });

  it("refuses a step the signature was not made for", async () => {
    const { repo, state } = memoryRepo({ dialTarget: OWN_PHONE });
    const signedForDial = signedRequest("voice", callParams("in-progress", { DialCallStatus: "no-answer" }), { query: "?step=dial" });
    const tampered = new Request(`http://localhost:3000/api/webhooks/twilio/voice?step=recording`, { method: "POST", headers: signedForDial.headers, body: await signedForDial.text() });
    expect((await handleTwilioWebhook(tampered, "voice", deps(repo))).status).toBe(403);
    expect(state.calls.size).toBe(0);
  });

  it("moves the call forward on status callbacks and answers them with empty TwiML", async () => {
    const { repo, state } = memoryRepo();
    await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo));
    const completed = await handleTwilioWebhook(signedRequest("voice", callParams("completed", { CallDuration: "14" })), "voice", deps(repo));
    expect(await completed.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(state.calls.get(CALL)).toMatchObject({ status: "completed", durationSeconds: 14, missed: true });
    expect(state.textBacks).toHaveLength(1);
  });

  it("stores withheld numbers as null and rejects calls to unprovisioned numbers", async () => {
    const { repo, state } = memoryRepo();
    await handleTwilioWebhook(signedRequest("voice", callParams("ringing", { From: "+266696687" })), "voice", deps(repo));
    expect(state.calls.get(CALL)?.from).toBeNull();

    const unrouted = memoryRepo({ routed: false });
    const response = await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(unrouted.repo));
    expect(await response.text()).toContain("<Reject/>");
    expect(unrouted.state.calls.size).toBe(0);
    expect(unrouted.state.textBacks).toEqual([]);
  });
});

describe("voice, Autofix's own line (A420)", () => {
  const CALL = "CA00000000000000000000000000000009";
  const RECORDING = "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000009";
  const PLATFORM_ENV = { ...ENV, AUTOFIX_PLATFORM_VOICE_NUMBERS: ` ${PLATFORM_NUMBER} , not-a-number,+44` };
  const callParams = (status: string, extra: Record<string, string> = {}) => ({ CallSid: CALL, From: CUSTOMER, To: PLATFORM_NUMBER, CallStatus: status, Direction: "inbound", ...extra });
  const voiceUrl = (step: string) => `${BASE}/api/webhooks/twilio/voice?step=${step}`;
  const platformDeps = (repo: TwilioWebhookRepo, extra: Record<string, unknown> = {}) => ({ repo: () => repo, env: PLATFORM_ENV, log, ...extra });

  it("reads E.164 platform numbers from AUTOFIX_PLATFORM_VOICE_NUMBERS and ignores the rest", () => {
    expect([...platformVoiceNumbers(PLATFORM_ENV)]).toEqual([PLATFORM_NUMBER]);
    expect(platformVoiceNumbers({}).size).toBe(0);
  });

  it("greets in Autofix's name and takes a voicemail: no ring-through, no text-back, no AI front desk, no garage", async () => {
    // Even with a garage dial target and the front desk on, the platform line never uses them.
    const { repo, state } = memoryRepo({ dialTarget: "+441302000101" });
    repo.aiFrontDeskVoiceReady = vi.fn(async () => true);
    const findGarage = vi.spyOn(repo, "findGarageByNumber");
    const drainQueued = vi.fn(async () => undefined);
    const prewarm = vi.fn(async () => undefined);
    const relay = { url: "wss://voice.example/relay", healthUrl: "https://voice.example/healthz", secret: "relay-secret-0123456789abcdef0123" };
    const response = await handleTwilioWebhook(
      signedRequest("voice", callParams("ringing")),
      "voice",
      platformDeps(repo, { drainQueued, voiceRelayTarget: relay, prewarm }),
    );
    const xml = await response.text();
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-GB">Thanks for calling Autofix. We can&apos;t take your call right now. Please leave a message after the tone and we&apos;ll get back to you.</Say>`
        + `<Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" action="${voiceUrl("recorded")}" method="POST" recordingStatusCallback="${voiceUrl("recording")}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>`
        + `<Say language="en-GB">We didn&apos;t get a message. Goodbye.</Say><Hangup/></Response>`,
    );
    expect(state.platformCalls.get(CALL)).toEqual({ callSid: CALL, from: CUSTOMER, to: PLATFORM_NUMBER, status: "ringing", durationSeconds: null });
    expect(state.calls.size).toBe(0);
    expect(state.textBacks).toEqual([]);
    expect(findGarage).not.toHaveBeenCalled();
    expect(repo.aiFrontDeskVoiceReady).not.toHaveBeenCalled();
    expect(drainQueued).not.toHaveBeenCalled();
    expect(prewarm).not.toHaveBeenCalled();
    expect(state.finished.at(-1)).toMatchObject({ key: `voice:${CALL}:ringing`, status: "processed", outcome: "platform_call_voicemail" });
  });

  it("stores the voicemail on the platform call and moves it forward on status callbacks", async () => {
    const { repo, state } = memoryRepo();
    await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", platformDeps(repo));
    const recording = { CallSid: CALL, RecordingSid: "RE00000000000000000000000000000009", RecordingUrl: RECORDING, RecordingStatus: "completed", RecordingDuration: "31" };
    await handleTwilioWebhook(signedRequest("voice", recording, { query: "?step=recording" }), "voice", platformDeps(repo));
    expect(state.platformCalls.get(CALL)?.voicemail).toEqual({ url: RECORDING, durationSeconds: 31 });
    const completed = await handleTwilioWebhook(signedRequest("voice", callParams("completed", { CallDuration: "48" })), "voice", platformDeps(repo));
    expect(await completed.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(state.platformCalls.get(CALL)).toMatchObject({ status: "completed", durationSeconds: 48 });
  });

  it("answers Twilio's retry with the same TwiML without writing twice, and hangs up a dial step", async () => {
    const { repo, state } = memoryRepo();
    const record = vi.spyOn(repo, "recordPlatformCall");
    const first = await (await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", platformDeps(repo))).text();
    const retry = await (await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", platformDeps(repo))).text();
    expect(retry).toBe(first);
    expect(record).toHaveBeenCalledTimes(1);
    const dial = await handleTwilioWebhook(signedRequest("voice", callParams("in-progress", { DialCallStatus: "no-answer" }), { query: "?step=dial" }), "voice", platformDeps(repo));
    const relayStep = await handleTwilioWebhook(signedRequest("voice", callParams("in-progress"), { query: "?step=relay" }), "voice", platformDeps(repo));
    expect(await relayStep.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(await dial.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(state.textBacks).toEqual([]);
  });

  it("is an ordinary unrouted number when it is not configured", async () => {
    const { repo, state } = memoryRepo();
    const response = await handleTwilioWebhook(signedRequest("voice", callParams("ringing")), "voice", deps(repo));
    expect(await response.text()).toContain("<Reject/>");
    expect(state.platformCalls.size).toBe(0);
  });

  it("does not change garage numbers", async () => {
    const { repo, state } = memoryRepo();
    await handleTwilioWebhook(signedRequest("voice", { ...callParams("ringing"), To: GARAGE_NUMBER }), "voice", platformDeps(repo));
    expect(state.calls.get(CALL)).toMatchObject({ garageId: GARAGE, missed: true });
    expect(state.platformCalls.size).toBe(0);
    expect(state.textBacks).toEqual([`call-${CALL}`]);
  });
});

describe("Supabase webhook repository", () => {
  it("stores a platform-line call in platform_calls, never in calls, without a garage", async () => {
    const fake = createFakeSupabase({ from: () => ({ data: null }) });
    const repo = createSupabaseTwilioWebhookRepo(fake.client);
    expect(await repo.recordPlatformCall({ callSid: "CA1", from: CUSTOMER, to: PLATFORM_NUMBER, status: "ringing", durationSeconds: null })).toEqual({ outcome: "created" });
    const insert = fake.queries.find((query) => query.operation === "insert")!;
    expect(insert.table).toBe("platform_calls");
    expect(insert.values).toEqual({ provider_call_sid: "CA1", from_number: CUSTOMER, to_number: PLATFORM_NUMBER, status: "ringing", duration_s: null });
    expect(fake.queries.some((query) => query.table === "calls")).toBe(false);
  });

  it("stores a voicemail on platform_calls when no garage call has that CallSid", async () => {
    const fake = createFakeSupabase({ from: (query) => ({ data: query.table === "calls" ? [] : [{ id: "p1" }] }) });
    const repo = createSupabaseTwilioWebhookRepo(fake.client);
    expect(await repo.recordVoicemail("CA1", { url: "https://api.twilio.com/x", durationSeconds: 5 })).toBe(true);
    expect(fake.queries.map((query) => [query.table, query.operation])).toEqual([["calls", "update"], ["platform_calls", "update"]]);
  });
  it("routes only provisioned numbers (provider_sid set)", async () => {
    const fake = createFakeSupabase({ from: () => ({ data: { garage_id: GARAGE, purpose: "messaging", garages: { name: "Hartley Road Motors" } } }) });
    const repo = createSupabaseTwilioWebhookRepo(fake.client);
    expect(await repo.findGarageByNumber(GARAGE_NUMBER)).toEqual({ garageId: GARAGE, purpose: "messaging", garageName: "Hartley Road Motors" });
    const query = fake.queries[0]!;
    expect(query.table).toBe("garage_phone_numbers");
    expect(filterValue(query, "eq", "number")).toBe(GARAGE_NUMBER);
    expect(query.filters).toContainEqual({ method: "not", args: ["provider_sid", "is", null] });
  });

  it("moves a delivered reminder forward from sent, scoped to its garage", async () => {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.operation === "select" && query.table === "messages") return { data: { id: "m1", garage_id: GARAGE, status: "sent", direction: "outbound" } };
        if (query.operation === "select" && query.table === "reminder_sends") return { data: { id: "r1", garage_id: GARAGE, status: "sent" } };
        return { data: null, count: 1 };
      },
    });
    const repo = createSupabaseTwilioWebhookRepo(fake.client);
    expect(await repo.applyDeliveryStatus("SM1", "failed", 30003)).toEqual({ messages: 1, reminders: 1 });
    const updates = fake.queries.filter((query) => query.operation === "update");
    expect(updates.map((query) => [query.table, query.values, filterValue(query, "eq", "garage_id"), filterValue(query, "eq", "status")])).toEqual([
      ["messages", { status: "failed", error_code: "twilio:30003" }, GARAGE, "sent"],
      ["reminder_sends", { status: "failed", error_code: "twilio:30003" }, GARAGE, "sent"],
    ]);
  });

  it("never moves a delivered message back", async () => {
    const fake = createFakeSupabase({
      from: (query) => (query.operation === "select" ? { data: { id: "m1", garage_id: GARAGE, status: "delivered", direction: "outbound" } } : { data: null, count: 1 }),
    });
    expect(await createSupabaseTwilioWebhookRepo(fake.client).applyDeliveryStatus("SM1", "sent", null)).toEqual({ messages: 0, reminders: 0 });
    expect(fake.queries.filter((query) => query.operation === "update")).toEqual([]);
  });
});
