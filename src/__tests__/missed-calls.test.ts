import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelKind, MessageChannel, SendResult } from "@/lib/messaging/channel";
import { clearMockOutbox, createMockChannel, getMockOutbox } from "@/lib/messaging/mock";
import { createFakeSupabase, filterValue, hasFilter } from "./support/fake-supabase";
import { jobContext, jobRow } from "./support/jobs";

// P4.1 missed calls: the text-back (service message: no stored consent and no
// quiet hours, but opt-outs, one per number per garage per 24 h, UK mobiles
// only), the calls.text_back job, the "Needs your OK" data, "Mark handled",
// and the voicemail proxy.

const harness = vi.hoisted(() => ({
  admin: null as null | Record<string, unknown>,
  revalidated: [] as string[],
  audits: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: vi.fn(async () => harness.admin) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => harness.revalidated.push(path) }));
vi.mock("@/lib/admin/audit", () => ({
  recordAdminAudit: vi.fn(async (garageId: string, entry: Record<string, unknown>) => {
    harness.audits.push([garageId, entry]);
    return true;
  }),
}));

const { sendCallTextBack, TEXT_BACK_MAX_DELAY_MS } = await import("@/lib/calls/text-back");
type TextBackRepo = import("@/lib/calls/text-back").TextBackRepo;
const { createCallsTextBackHandler } = await import("@/lib/jobs/handlers/calls-text-back");
const { listMissedCallsNeedingOk, countMissedCallsNeedingOk } = await import("@/lib/calls/missed-calls");
const { markMissedCallHandled, markMissedCallHandledAction } = await import("@/lib/calls/actions");
const { streamVoicemail } = await import("@/lib/calls/voicemail");

const GARAGE = "a0000000-0000-4000-8000-00000000000a";
const CALL = "c0000000-0000-4000-8000-000000000001";
const CALLER = "+447700900123";
const NOW = new Date("2026-11-01T23:10:00Z"); // a Sunday night: outside the reminder send window
const garage = { id: GARAGE, slug: "hartley-road", customDomain: null, name: "Hartley Road Motors" };
const PROD = { NODE_ENV: "production", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk" };

type Overrides = {
  call?: Partial<{ id: string; fromNumber: string | null; missed: boolean; textBackMessageId: string | null; createdAt: string }> | null;
  rule?: { enabled: boolean; channel: string; template: string } | null;
  customer?: { name: string | null; channel: string | null; optedOutAt: string | null } | null;
  keyword?: "stop" | "start" | null;
  claim?: Awaited<ReturnType<TextBackRepo["claim"]>>;
};

function fakeRepo(overrides: Overrides = {}) {
  const calls = { claims: [] as Array<{ channel: string; body: string; provider: string }>, results: [] as Array<Record<string, unknown>> };
  const repo: TextBackRepo = {
    loadCall: async () => (overrides.call === null ? null : { id: CALL, fromNumber: CALLER, missed: true, textBackMessageId: null, createdAt: new Date(NOW.getTime() - 20_000).toISOString(), ...overrides.call }),
    loadRule: async () => (overrides.rule === undefined ? { enabled: true, channel: "customer", template: "Sorry we missed your call. Book online in about a minute: {link} or we'll call you back soon. {garage}" } : overrides.rule),
    loadCustomer: async () => overrides.customer ?? null,
    latestKeyword: async () => overrides.keyword ?? null,
    claim: async (_garageId, _callId, message) => {
      calls.claims.push(message);
      return overrides.claim ?? { status: "claimed", messageId: "m1", to: CALLER };
    },
    recordResult: async (_garageId, messageId, result) => {
      calls.results.push({ messageId, ...result });
    },
  };
  return { repo, calls };
}

async function textBack(overrides: Overrides = {}, channelFor: (kind: ChannelKind) => MessageChannel = (kind) => createMockChannel(kind)) {
  const { repo, calls } = fakeRepo(overrides);
  const result = await sendCallTextBack({ garage, callId: CALL, repo, channelFor, now: NOW, env: PROD });
  return { result, calls };
}

beforeEach(() => {
  clearMockOutbox();
  harness.admin = null;
  harness.revalidated = [];
  harness.audits = [];
});

describe("the text-back", () => {
  it("texts a missed caller straight away (even on a Sunday night) with the booking link and the opt-out line", async () => {
    const { result, calls } = await textBack();
    expect(result).toEqual({ outcome: "sent", channel: "sms" });
    const [sent] = getMockOutbox();
    expect(sent).toMatchObject({ kind: "sms", to: CALLER, idempotencyKey: `call_text_back:${CALL}` });
    expect(sent!.senderId).toBeUndefined();
    expect(sent!.body).toBe("Sorry we missed your call. Book online in about a minute: https://hartley-road.autofix.vitalos.co.uk/ or we'll call you back soon. Hartley Road Motors\nReply STOP to opt out.");
    expect(calls.claims).toEqual([{ channel: "sms", body: sent!.body, provider: "mock" }]);
    expect(calls.results).toEqual([{ messageId: "m1", status: "queued", providerMessageId: sent!.providerMessageId }]);
  });

  it("uses WhatsApp when the rule says so or the customer chose it, and SMS for email rules", async () => {
    expect((await textBack({ rule: { enabled: true, channel: "whatsapp", template: "Missed you. {link}" } })).result.channel).toBe("whatsapp");
    expect((await textBack({ customer: { name: "Sam Driver", channel: "whatsapp", optedOutAt: null } })).result.channel).toBe("whatsapp");
    expect((await textBack({ rule: { enabled: true, channel: "email", template: "Missed you. {link}" } })).result.channel).toBe("sms");
  });

  it("greets a known customer by first name", async () => {
    await textBack({ rule: { enabled: true, channel: "sms", template: "Hi {first_name}, sorry we missed you. {link}" }, customer: { name: "Sam Driver", channel: "sms", optedOutAt: null } });
    expect(getMockOutbox()[0]!.body).toMatch(/^Hi Sam, sorry we missed you\. https:/);
  });

  it.each([
    ["the call was answered", { call: { missed: false } }, "not_missed"],
    ["the number was withheld", { call: { fromNumber: null } }, "withheld"],
    ["it already has a text-back", { call: { textBackMessageId: "m0" } }, "already_sent"],
    ["the caller rang from a landline", { call: { fromNumber: "+441302000999" } }, "not_mobile"],
    ["the call was long ago (a stuck queue)", { call: { createdAt: new Date(NOW.getTime() - TEXT_BACK_MAX_DELAY_MS - 1000).toISOString() } }, "too_late"],
    ["the missed-call rule is off", { rule: { enabled: false, channel: "sms", template: "x {link}" } }, "rule_disabled"],
    ["the garage has no missed-call rule", { rule: null }, "rule_disabled"],
    ["the customer opted out", { customer: { name: "Ola", channel: "sms", optedOutAt: "2026-10-01T10:00:00Z" } }, "opted_out"],
    ["the number texted STOP (not a customer)", { keyword: "stop" as const }, "opted_out"],
    ["the template has a placeholder with no value", { rule: { enabled: true, channel: "sms", template: "Hi {first_name}! {link}" } }, "template_placeholders"],
    ["the number was texted back in the last 24 hours", { claim: { status: "skipped" as const, reason: "recent_text_back" } }, "recent_text_back"],
    ["the call does not exist", { call: null }, "not_found"],
  ])("sends nothing when %s", async (_label, overrides, outcome) => {
    const { result } = await textBack(overrides as Overrides);
    expect(result.outcome).toBe(outcome);
    expect(getMockOutbox()).toEqual([]);
  });

  it("texts a number whose last keyword was START again", async () => {
    expect((await textBack({ keyword: "start" })).result.outcome).toBe("sent");
  });

  it("records a failed or ambiguous send on the message and never resends it", async () => {
    const failing = (result: SendResult) => (kind: ChannelKind): MessageChannel => ({ kind, mode: "live", send: async () => result });
    const invalid = await textBack({}, failing({ ok: false, code: "invalid_recipient", retryable: false, providerCode: 21211 }));
    expect(invalid.result.outcome).toBe("failed");
    expect(invalid.calls.results).toEqual([{ messageId: "m1", status: "failed", errorCode: "invalid_recipient:21211" }]);
    const timeout = await textBack({}, failing({ ok: false, code: "provider_error", retryable: false, providerCode: "timeout", ambiguous: true }));
    expect(timeout.calls.results).toEqual([{ messageId: "m1", status: "failed", errorCode: "ambiguous:provider_error:timeout" }]);
    expect(timeout.calls.claims).toHaveLength(1);
  });
});

describe("calls.text_back job", () => {
  it("loads the garage and sends through the job's channel", async () => {
    const db = createFakeSupabase({ from: () => ({ data: { id: GARAGE, slug: "hartley-road", name: "Hartley Road Motors", status: "active", garage_domains: [] } }) });
    const handler = createCallsTextBackHandler({ repo: () => fakeRepo().repo, channelFor: (kind) => createMockChannel(kind) });
    const payload = { garageId: GARAGE, callId: CALL };
    expect(await handler(payload, jobContext({ job: jobRow("calls.text_back", payload, GARAGE), db: db.client, now: NOW, env: PROD }))).toEqual({ outcome: "sent" });
    expect(getMockOutbox()).toHaveLength(1);
  });

  it("refuses a payload with anything but ids", async () => {
    const handler = createCallsTextBackHandler({ repo: () => fakeRepo().repo });
    const error = await handler({ garageId: GARAGE, callId: CALL, phone: CALLER }, jobContext({ job: jobRow("calls.text_back"), db: {} as never, now: NOW })).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "INVALID_PAYLOAD", retry: false });
  });
});

describe("Needs your OK: missed calls", () => {
  const rows = [
    { id: "c1", from_number: CALLER, created_at: "2026-10-27T08:12:00Z", voicemail_url: "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000001", voicemail_duration_s: 17, text_back_message_id: "m1" },
    { id: "c2", from_number: "+447700900456", created_at: "2026-10-27T07:50:00Z", voicemail_url: null, voicemail_duration_s: null, text_back_message_id: null },
    { id: "c3", from_number: null, created_at: "2026-10-27T07:00:00Z", voicemail_url: null, voicemail_duration_s: null, text_back_message_id: null },
  ];

  it("lists unhandled missed calls with the caller's name, a masked number, call-back and voicemail links", async () => {
    const fake = createFakeSupabase({ from: (query) => (query.table === "calls" ? { data: rows } : { data: [{ name: "Sam Driver", phone: CALLER }] }) });
    const cards = await listMissedCallsNeedingOk(fake.client, GARAGE, { limit: 5 });
    const callsQuery = fake.queries[0]!;
    expect(callsQuery.filters).toEqual(expect.arrayContaining([
      { method: "eq", args: ["garage_id", GARAGE] },
      { method: "eq", args: ["missed", true] },
      { method: "is", args: ["handled_at", null] },
      { method: "limit", args: [5] },
    ]));
    expect(hasFilter(fake.queries[1]!, "eq", "garage_id", GARAGE)).toBe(true);
    expect(filterValue(fake.queries[1]!, "in", "phone")).toEqual([CALLER, "+447700900456"]);
    expect(cards).toEqual([
      { id: "c1", at: "2026-10-27T08:12:00Z", callerName: "Sam Driver", maskedNumber: "07••• •••123", callBackHref: `tel:${CALLER}`, voicemailHref: "/api/admin/calls/c1/voicemail", voicemailSeconds: 17, textedBack: true },
      { id: "c2", at: "2026-10-27T07:50:00Z", callerName: null, maskedNumber: "07••• •••456", callBackHref: "tel:+447700900456", voicemailHref: null, voicemailSeconds: null, textedBack: false },
      { id: "c3", at: "2026-10-27T07:00:00Z", callerName: null, maskedNumber: null, callBackHref: null, voicemailHref: null, voicemailSeconds: null, textedBack: false },
    ]);
    // The Twilio link itself never reaches the browser.
    expect(JSON.stringify(cards)).not.toContain("api.twilio.com");
  });

  it("is empty (not an error) when the read fails, and counts for a badge", async () => {
    const broken = createFakeSupabase({ from: () => ({ error: { code: "42501" } }) });
    expect(await listMissedCallsNeedingOk(broken.client, GARAGE)).toEqual([]);
    expect(await countMissedCallsNeedingOk(broken.client, GARAGE)).toBe(0);
    const counting = createFakeSupabase({ from: () => ({ data: null, count: 3 }) });
    expect(await countMissedCallsNeedingOk(counting.client, GARAGE)).toBe(3);
  });
});

describe("Mark handled", () => {
  function signedIn(updated: unknown[] = [{ id: CALL }]) {
    const fake = createFakeSupabase({ from: () => ({ data: updated }) });
    harness.admin = { client: fake.client, garage: { id: GARAGE }, user: { id: "u1" } };
    return fake;
  }

  it("marks the call handled as the signed-in member, in the session's garage, and audits it", async () => {
    const fake = signedIn();
    const form = new FormData();
    form.set("callId", CALL);
    form.set("garageId", "b0000000-0000-4000-8000-00000000000b");
    await markMissedCallHandledAction(form);
    const update = fake.queries[0]!;
    expect(update.operation).toBe("update");
    expect(update.values).toEqual({ handled_at: expect.any(String), handled_by: "u1" });
    expect(update.filters).toEqual(expect.arrayContaining([
      { method: "eq", args: ["garage_id", GARAGE] },
      { method: "eq", args: ["id", CALL] },
      { method: "is", args: ["handled_at", null] },
    ]));
    expect(harness.audits).toEqual([[GARAGE, { actorId: "u1", action: "call.handled", entityType: "call", entityId: CALL }]]);
    expect(harness.revalidated).toEqual(["/app"]);
  });

  it("does nothing twice, refuses bad ids and signed-out users", async () => {
    signedIn([]);
    expect(await markMissedCallHandled(CALL)).toEqual({ ok: true, changed: false });
    expect(harness.audits).toEqual([]);
    expect(await markMissedCallHandled("not-a-uuid")).toEqual({ ok: false, code: "invalid" });
    harness.admin = null;
    expect(await markMissedCallHandled(CALL)).toEqual({ ok: false, code: "unauthorised" });
  });
});

describe("voicemail playback", () => {
  const ACCOUNT = "AC00000000000000000000000000000000";
  const RECORDING = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE00000000000000000000000000000001`;
  const env = { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: "twilio-test-token" };

  function client(url: string | null) {
    return createFakeSupabase({ from: () => ({ data: url === null ? null : { id: CALL, voicemail_url: url } }) }).client;
  }

  it("streams this account's recording with its credentials, privately, and audits the play", async () => {
    const fetchMock = vi.fn(async () => new Response("mp3-bytes", { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const audit = vi.fn(async () => true);
    const response = await streamVoicemail({ client: client(RECORDING), garageId: GARAGE, actorId: "u1", callId: CALL, env, fetch: fetchMock as never, audit });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mp3-bytes");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RECORDING}.mp3`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${ACCOUNT}:twilio-test-token`).toString("base64")}`);
    expect(audit).toHaveBeenCalledWith(GARAGE, { actorId: "u1", action: "call.voicemail_played", entityType: "call", entityId: CALL });
  });

  it("never sends credentials anywhere else, and says not found or not configured", async () => {
    const fetchMock = vi.fn();
    const audit = vi.fn();
    const other = "https://api.twilio.com/2010-04-01/Accounts/AC11111111111111111111111111111111/Recordings/RE00000000000000000000000000000001";
    expect((await streamVoicemail({ client: client(other), garageId: GARAGE, actorId: "u1", callId: CALL, env, fetch: fetchMock as never, audit })).status).toBe(404);
    expect((await streamVoicemail({ client: client("https://evil.example/x"), garageId: GARAGE, actorId: "u1", callId: CALL, env, fetch: fetchMock as never, audit })).status).toBe(404);
    expect((await streamVoicemail({ client: client(null), garageId: GARAGE, actorId: "u1", callId: CALL, env, fetch: fetchMock as never, audit })).status).toBe(404);
    expect((await streamVoicemail({ client: client(RECORDING), garageId: GARAGE, actorId: "u1", callId: CALL, env: {}, fetch: fetchMock as never, audit })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
