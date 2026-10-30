/**
 * P5.12 AI front desk on Pro (voice desk): the hook in the Twilio voice webhook (Essentials unchanged,
 * Pro with the switch on and minutes left gets the disclosure and the ConversationRelay connection to
 * Pitline's voice service, a failed session falls back to voicemail + text-back), the relay claim, the
 * settings states and actions' plan and role gates, and the usage month shared with the Plan page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  admin: null as unknown,
  audits: [] as Array<{ action: string; entityId: string; detail?: Record<string, unknown> }>,
  revalidated: [] as string[],
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcResult: { data: null as unknown, error: null as null | { code?: string; message?: string } },
  issued: [] as unknown[],
  issueError: null as Error | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => harness.revalidated.push(path) }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/settings/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/settings/server")>();
  return {
    ...original,
    requireSetupContext: vi.fn(async () => harness.admin),
    auditSetupChange: vi.fn(async (_admin: unknown, action: string, _type: string, entityId: string, detail?: Record<string, unknown>) => {
      harness.audits.push({ action, entityId, detail });
    }),
  };
});
vi.mock("@/lib/agent-api/store", () => ({
  issueAgentToken: vi.fn(async (input: { garageId: string; name: string; audience: string }) => {
    if (harness.issueError) throw harness.issueError;
    harness.issued.push(input);
    return { id: "77777777-7777-4777-8777-777777777777", garageId: input.garageId, name: input.name, scopes: [], audience: input.audience, createdAt: "2026-10-28T10:00:00Z", token: `afat_${"T".repeat(43)}` };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));

import { issueWorkforceTokenAction, revokeAgentTokenAction, setAiFrontDeskAction } from "@/app/app/(protected)/settings/ai-front-desk/actions";
import { initialIssueTokenState, parseTokenName } from "@/lib/ai-front-desk/forms";
import { voiceDeskStatus, workforceConnectionStatus } from "@/lib/ai-front-desk/hand-off";
import { usageMonthFirst, voiceServiceConfigured, workforceConnection, type AgentTokenRow } from "@/lib/ai-front-desk/server";
import { parseVoiceRelayTarget, RELAY_CLAIM_TTL_SECONDS, relayConnectUrl, signRelayClaim, verifyRelayClaim, type VoiceRelayTarget } from "@/lib/ai-front-desk/voice-relay";
import { localDateKey, monthStart } from "@/lib/admin/dates";
import { aiDeskTwiml, aiDisclosure, isVoiceStep } from "@/lib/calls/twiml";
import { computeTwilioSignature } from "@/lib/messaging/twilio";
import { handleTwilioWebhook, type CallRecord, type TwilioWebhookRepo } from "@/lib/messaging/twilio-webhooks";
import { PlanRequiredError } from "@/lib/plans/entitlements";

// ---------------------------------------------------------------------------
// Relay target, claim and TwiML
// ---------------------------------------------------------------------------

const SECRET = "voice-relay-secret-0123456789-abcdefghij";
const RELAY: VoiceRelayTarget = { url: "wss://autofix-voice.example.azurecontainerapps.io/relay", healthUrl: "https://autofix-voice.example.azurecontainerapps.io/healthz", secret: SECRET };
const GARAGE = "a0000000-0000-4000-8000-00000000000a";
const CALL = "CA00000000000000000000000000000001";

describe("voice relay target and claim", () => {
  it("needs a wss:// URL without a query and a 32+ character secret", () => {
    expect(parseVoiceRelayTarget({ VOICE_RELAY_URL: RELAY.url, VOICE_RELAY_SECRET: ` ${SECRET} ` })).toEqual(RELAY);
    for (const [url, secret] of [
      ["", SECRET], [RELAY.url, ""], [RELAY.url, "short"], ["https://autofix-voice.example/relay", SECRET],
      [`${RELAY.url}?g=1`, SECRET], ["wss://user:pw@host/relay", SECRET], ["not a url", SECRET],
    ] as const) {
      expect(parseVoiceRelayTarget({ VOICE_RELAY_URL: url, VOICE_RELAY_SECRET: secret }), `${url} / ${secret.length}`).toBeNull();
    }
    expect(voiceServiceConfigured({})).toBe(false);
    expect(voiceServiceConfigured({ VOICE_RELAY_URL: RELAY.url, VOICE_RELAY_SECRET: SECRET })).toBe(true);
  });

  it("matches the shared test vector (services/voice/src/claim.test.ts checks the same one)", () => {
    expect(signRelayClaim("test-secret-test-secret-test-secret", { garageId: GARAGE, callSid: CALL, expires: 1793000000 }))
      .toBe("a8df7828c754f67da80ce34466c1e0b0da5e6ec95ed72d8f3c475c3b429d746e");
  });

  it("puts the garage, CallSid, expiry and signature in the URL and nothing about the caller; the claim verifies until it expires", () => {
    const now = new Date("2026-10-29T10:00:00Z");
    const url = new URL(relayConnectUrl(RELAY, { garageId: GARAGE, callSid: CALL, now }));
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(RELAY.url);
    expect([...url.searchParams.keys()]).toEqual(["g", "c", "e", "s"]);
    const input = { garageId: url.searchParams.get("g"), callSid: url.searchParams.get("c"), expires: url.searchParams.get("e"), signature: url.searchParams.get("s") };
    expect(verifyRelayClaim(SECRET, input, now)).toEqual({ garageId: GARAGE, callSid: CALL, expires: now.getTime() / 1000 + RELAY_CLAIM_TTL_SECONDS });
    expect(verifyRelayClaim(SECRET, input, new Date(now.getTime() + RELAY_CLAIM_TTL_SECONDS * 1000))).toBeNull();
    expect(verifyRelayClaim("another-secret-another-secret-another", input, now)).toBeNull();
    expect(verifyRelayClaim(SECRET, { ...input, callSid: "CA00000000000000000000000000000002" }, now)).toBeNull();
    expect(verifyRelayClaim(SECRET, { ...input, garageId: "b0000000-0000-4000-8000-00000000000b" }, now)).toBeNull();
    expect(verifyRelayClaim(SECRET, { ...input, expires: String(Number(input.expires) + 3600) }, now)).toBeNull();
  });

  it("speaks the approved disclosure, then connects ConversationRelay in en-GB with the step=relay action", () => {
    expect(aiDisclosure("Hartley Road")).toBe("Hi, you're through to the automated assistant for Hartley Road. I can check times and book you in, or take a message for the team.");
    const xml = aiDeskTwiml({ garageName: "Tom & Jo's", relayUrl: "wss://h/relay?g=1&c=2", actionUrl: "https://a/voice?step=relay" });
    expect(xml).toBe(`<Say language="en-GB">Hi, you&apos;re through to the automated assistant for Tom &amp; Jo&apos;s. I can check times and book you in, or take a message for the team.</Say>`
      + `<Connect action="https://a/voice?step=relay" method="POST"><ConversationRelay url="wss://h/relay?g=1&amp;c=2" language="en-GB" interruptible="any"/></Connect>`);
    expect(isVoiceStep("relay")).toBe(true);
    expect(isVoiceStep("agent")).toBe(false);
  });
});

describe("settings states", () => {
  it("describes partner tokens from the garage's tokens", () => {
    expect(workforceConnectionStatus({ activeTokens: 0, lastUsedAt: null }).label).toBe("No tokens");
    expect(workforceConnectionStatus({ activeTokens: 1, lastUsedAt: null }).label).toBe("Not used yet");
    expect(workforceConnectionStatus({ activeTokens: 1, lastUsedAt: "2026-10-28T09:00:00Z" })).toMatchObject({ tone: "success", label: "In use" });
    const token = (overrides: Partial<AgentTokenRow>): AgentTokenRow => ({ id: "t", name: "n", audience: "workforce", scopes: [], lastUsedAt: null, revokedAt: null, createdAt: "2026-10-01T00:00:00Z", ...overrides });
    expect(workforceConnection([
      token({ lastUsedAt: "2026-10-27T09:00:00Z" }),
      token({ lastUsedAt: "2026-10-28T09:00:00Z", revokedAt: "2026-10-28T10:00:00Z" }),
      token({ audience: "askbridge", lastUsedAt: "2026-10-28T11:00:00Z" }),
      token({}),
    ])).toEqual({ activeTokens: 2, lastUsedAt: "2026-10-27T09:00:00Z" });
  });

  it("says whether calls are being answered, and why not", () => {
    const ready = { serviceConfigured: true, enabled: true, hasNumber: true, overAllowance: false };
    expect(voiceDeskStatus(ready)).toMatchObject({ tone: "success", label: "Answering" });
    expect(voiceDeskStatus({ ...ready, enabled: false }).label).toBe("Off");
    expect(voiceDeskStatus({ ...ready, serviceConfigured: false }).label).toBe("Waiting for Vitalos");
    expect(voiceDeskStatus({ ...ready, hasNumber: false }).label).toBe("No Pitline number");
    expect(voiceDeskStatus({ ...ready, overAllowance: true }).label).toBe("Allowance used");
  });
});

// ---------------------------------------------------------------------------
// Voice webhook hook point
// ---------------------------------------------------------------------------

const AUTH_TOKEN = "twilio-test-auth-token-0123456789";
const BASE = "https://pitline.co.uk";
const ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL: BASE, PLAN_PRO_AI_MINUTES: "200" };
const GARAGE_NUMBER = "+447700100200";
const CALLER = "+447700900123";
const OWN_PHONE = "+441302000101";

function signedVoice(params: Record<string, string>, query = "") {
  const body = new URLSearchParams(params).toString();
  const path = `/api/webhooks/twilio/voice${query}`;
  const signature = computeTwilioSignature(`${BASE}${path}`, new URLSearchParams(body), AUTH_TOKEN);
  return new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body });
}

const callParams = (status: string, extra: Record<string, string> = {}) => ({ CallSid: CALL, From: CALLER, To: GARAGE_NUMBER, CallStatus: status, Direction: "inbound", ...extra });

function voiceRepo(options: { ready?: boolean | "throws"; dialTarget?: string; withHook?: boolean } = {}) {
  const events = new Set<string>();
  const state = { calls: new Map<string, CallRecord & { id: string }>(), textBacks: [] as string[], readyChecks: [] as Array<number | null> };
  const repo: TwilioWebhookRepo = {
    async claimEvent(key) {
      if (events.has(key)) return false;
      events.add(key);
      return true;
    },
    async finishEvent() {},
    async findGarageByNumber(number) {
      return number === GARAGE_NUMBER ? { garageId: GARAGE, garageName: "Hartley Road", purpose: "forwarding" } : null;
    },
    async findCustomerId() { return null; },
    async insertInboundMessage() { return null; },
    async applyKeyword() { return { customers: 0, cancelled: 0, unchanged: 0 }; },
    async garagesThatMessaged() { return []; },
    async applyDeliveryStatus() { return { messages: 0, reminders: 0 }; },
    async recordCall(call) {
      const existing = state.calls.get(call.callSid);
      const id = existing?.id ?? `call-${call.callSid}`;
      state.calls.set(call.callSid, existing ? { ...existing, status: call.status } : { ...call, id });
      return { outcome: existing ? "updated" : "created", callId: id };
    },
    async queueHelpReply() {},
    async findDialTarget() { return options.dialTarget ?? null; },
    async callerRangRecently() { return false; },
    async recordDialOutcome(_garageId, callSid, outcome) {
      const existing = state.calls.get(callSid);
      if (!existing) return { callId: null };
      state.calls.set(callSid, { ...existing, missed: outcome.missed });
      return { callId: existing.id };
    },
    async recordVoicemail() { return true; },
    async recordPlatformCall() { return { outcome: "created" as const }; },
    async queueTextBack(_garageId, callId) { state.textBacks.push(callId); },
  };
  if (options.withHook !== false) {
    repo.aiFrontDeskVoiceReady = async (_garageId, allowance) => {
      state.readyChecks.push(allowance);
      if (options.ready === "throws") throw new Error("database down");
      return options.ready ?? false;
    };
    repo.findCallId = async (_garageId, callSid) => state.calls.get(callSid)?.id ?? null;
  }
  return { repo, state };
}

function deps(repo: TwilioWebhookRepo, relay: VoiceRelayTarget | null = RELAY) {
  const prewarmed: string[] = [];
  const after: Array<() => Promise<unknown>> = [];
  return {
    prewarmed,
    after,
    repo: () => repo,
    env: ENV,
    voiceRelayTarget: relay,
    prewarm: async (url: string) => { prewarmed.push(url); },
    afterResponse: (task: () => Promise<unknown>) => { after.push(task); },
  };
}

async function runAfter(d: ReturnType<typeof deps>) {
  for (const task of d.after.splice(0)) await task();
}

describe("voice webhook: Essentials keeps missed-call text-back and voicemail", () => {
  it("not ready (Essentials, switched off or minutes used up) gets the voicemail and the text-back even with the service configured", async () => {
    const { repo, state } = voiceRepo({ ready: false });
    const d = deps(repo);
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", d)).text();
    expect(xml).toContain("<Record ");
    expect(xml).not.toContain("ConversationRelay");
    expect(state.textBacks).toEqual([`call-${CALL}`]);
    expect(state.readyChecks).toEqual([200]);
    await runAfter(d);
    expect(d.prewarmed).toEqual([]);
  });

  it("a repo without the hook, no voice service, or a failing check: unchanged", async () => {
    for (const [setup, relay] of [[{ withHook: false, ready: true }, RELAY], [{ ready: true }, null], [{ ready: "throws" }, RELAY]] as const) {
      const { repo, state } = voiceRepo(setup);
      const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo, relay))).text();
      expect(xml).toContain("<Record ");
      expect(state.textBacks).toEqual([`call-${CALL}`]);
    }
  });

  it("the garage's own phone still rings first; the AI front desk is not even asked", async () => {
    const { repo, state } = voiceRepo({ ready: true, dialTarget: OWN_PHONE });
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo))).text();
    expect(xml).toContain(`<Number>${OWN_PHONE}</Number>`);
    expect(state.readyChecks).toEqual([]);
  });
});

describe("voice webhook: Pro with the AI front desk on answers missed calls", () => {
  it("a missed call hears the disclosure and is connected to the voice service, which is woken after the response; no text-back", async () => {
    const { repo, state } = voiceRepo({ ready: true });
    const d = deps(repo);
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", d)).text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><Response><Say language="en-GB">Hi, you&apos;re through to the automated assistant for Hartley Road\./);
    expect(xml).toContain(`<Connect action="${BASE}/api/webhooks/twilio/voice?step=relay" method="POST"><ConversationRelay url="${RELAY.url}?g=${GARAGE}&amp;c=${CALL}&amp;e=`);
    expect(xml).not.toContain(CALLER);
    expect(xml).not.toContain(SECRET);
    expect(state.calls.get(CALL)).toMatchObject({ missed: true });
    expect(state.textBacks).toEqual([]);
    expect(d.prewarmed).toEqual([]);
    await runAfter(d);
    expect(d.prewarmed).toEqual([RELAY.healthUrl]);
  });

  it("after the garage's phone goes unanswered the call goes to the AI front desk", async () => {
    const { repo, state } = voiceRepo({ ready: true, dialTarget: OWN_PHONE });
    await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo));
    const d = deps(repo);
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("in-progress", { DialCallStatus: "no-answer" }), "?step=dial"), "voice", d)).text();
    expect(xml).toContain("<ConversationRelay ");
    expect(state.textBacks).toEqual([]);
    await runAfter(d);
    expect(d.prewarmed).toEqual([RELAY.healthUrl]);
  });

  it("a failed session (service down) falls back to the voicemail and the text-back, once", async () => {
    const { repo, state } = voiceRepo({ ready: true });
    await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo));
    const request = () => signedVoice(callParams("in-progress", { SessionStatus: "failed", ErrorCode: "39001" }), "?step=relay");
    const xml = await (await handleTwilioWebhook(request(), "voice", deps(repo))).text();
    expect(xml).toContain("<Record ");
    expect(state.textBacks).toEqual([`call-${CALL}`]);
    await handleTwilioWebhook(request(), "voice", deps(repo));
    expect(state.textBacks).toHaveLength(1);
  });

  it("a session the desk ended for a message goes to the voicemail without a text-back", async () => {
    const { repo, state } = voiceRepo({ ready: true });
    await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo));
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("in-progress", { SessionStatus: "ended", HandoffData: '{"to":"voicemail"}' }), "?step=relay"), "voice", deps(repo))).text();
    expect(xml).toContain("<Record ");
    expect(state.textBacks).toEqual([]);
  });

  it.each([
    [{ SessionStatus: "ended", HandoffData: '{"to":"hangup","reason":"done"}' }],
    [{ SessionStatus: "completed", CallStatus: "completed" }],
    [{ SessionStatus: "ended", HandoffData: "not json" }],
  ])("a finished session hangs up: %j", async (extra) => {
    const { repo, state } = voiceRepo({ ready: true });
    await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo));
    const xml = await (await handleTwilioWebhook(signedVoice({ ...callParams("in-progress"), ...extra }, "?step=relay"), "voice", deps(repo))).text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Record");
    expect(state.textBacks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Usage month (same as the Plan page)
// ---------------------------------------------------------------------------

describe("AI minutes month", () => {
  it.each([
    ["2026-10-31T23:30:00Z", "2026-10-01"], // GMT: still October
    ["2026-03-31T23:30:00Z", "2026-04-01"], // BST: already April
    ["2026-03-29T00:30:00Z", "2026-03-01"], // spring-forward night
    ["2026-10-25T01:30:00Z", "2026-10-01"], // fall-back night
  ])("%s counts in the London month starting %s, exactly as Settings, Plan", (at, month) => {
    const now = new Date(at);
    expect(usageMonthFirst({ timezone: "Europe/London" }, now)).toBe(month);
    expect(usageMonthFirst({ timezone: "Europe/London" }, now)).toBe(monthStart(localDateKey(now, "Europe/London")));
  });
});

// ---------------------------------------------------------------------------
// Settings actions
// ---------------------------------------------------------------------------

const PRO = { plan: "pro", trialEndsAt: null, planChosen: "pro" };
const ESSENTIALS = { plan: "essentials", trialEndsAt: null, planChosen: "essentials" };

function signIn(role: string, plan = PRO) {
  harness.admin = {
    role,
    user: { id: "u1" },
    mfaVerified: true,
    garage: { id: GARAGE, name: "Hartley Road", timezone: "Europe/London", ...plan },
    client: {
      rpc: vi.fn(async (name: string, args: unknown) => {
        harness.rpcCalls.push({ name, args });
        return harness.rpcResult;
      }),
    },
  };
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return String((error as Error).message).replace("REDIRECT:", "");
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  harness.audits = [];
  harness.revalidated = [];
  harness.rpcCalls = [];
  harness.rpcResult = { data: { enabled: true }, error: null };
  harness.issued = [];
  harness.issueError = null;
});

describe("the switch", () => {
  it("the Pro owner switches it on and off through set_ai_front_desk()", async () => {
    signIn("owner");
    expect(await redirectOf(() => setAiFrontDeskAction(form({ enabled: "on" })))).toBe("/app/settings/ai-front-desk?done=enabled");
    expect(await redirectOf(() => setAiFrontDeskAction(form({ enabled: "off" })))).toBe("/app/settings/ai-front-desk?done=disabled");
    expect(harness.rpcCalls).toEqual([{ name: "set_ai_front_desk", args: { p_enabled: true } }, { name: "set_ai_front_desk", args: { p_enabled: false } }]);
  });

  it("an Essentials owner cannot switch it on (no database call) but can switch it off", async () => {
    signIn("owner", ESSENTIALS);
    expect(await redirectOf(() => setAiFrontDeskAction(form({ enabled: "on" })))).toBe("/app/settings/ai-front-desk?error=plan_required");
    expect(harness.rpcCalls).toEqual([]);
    expect(await redirectOf(() => setAiFrontDeskAction(form({ enabled: "off" })))).toBe("/app/settings/ai-front-desk?done=disabled");
  });

  it("managers cannot switch it; a PLAN_REQUIRED from the database is reported as such", async () => {
    signIn("manager");
    expect(await redirectOf(() => setAiFrontDeskAction(form({ enabled: "on" })))).toBe("/app/settings/ai-front-desk?error=owner_only");
    signIn("owner");
    harness.rpcResult = { data: null, error: { code: "P0001", message: "PLAN_REQUIRED: ai_front_desk" } };
    expect(await redirectOf(() => setAiFrontDeskAction(form({ enabled: "on" })))).toBe("/app/settings/ai-front-desk?error=plan_required");
  });
});

describe("Workforce tokens", () => {
  it("parses the token name", () => {
    expect(parseTokenName("  Workforce   calls ")).toEqual({ ok: true, name: "Workforce calls" });
    expect(parseTokenName("")).toMatchObject({ ok: false });
    expect(parseTokenName("x".repeat(81))).toMatchObject({ ok: false });
  });

  it("owners and managers on Pro get a workforce token once, audited without the token", async () => {
    signIn("manager");
    const state = await issueWorkforceTokenAction(initialIssueTokenState, form({ name: "Workforce calls" }));
    expect(state).toMatchObject({ status: "saved", token: `afat_${"T".repeat(43)}`, tokenName: "Workforce calls" });
    expect(harness.issued).toEqual([{ garageId: GARAGE, name: "Workforce calls", audience: "workforce" }]);
    expect(harness.audits).toEqual([{ action: "agent_token.issued", entityId: "77777777-7777-4777-8777-777777777777", detail: { name: "Workforce calls", audience: "workforce" } }]);
    expect(JSON.stringify(harness.audits)).not.toContain("afat_");
  });

  it("an Essentials garage, a technician or a bad name gets no token", async () => {
    signIn("owner", ESSENTIALS);
    expect(await issueWorkforceTokenAction(initialIssueTokenState, form({ name: "Workforce" }))).toMatchObject({ status: "error", message: expect.stringContaining("Pro") });
    signIn("technician");
    expect(await issueWorkforceTokenAction(initialIssueTokenState, form({ name: "Workforce" }))).toMatchObject({ status: "error" });
    signIn("owner");
    expect(await issueWorkforceTokenAction(initialIssueTokenState, form({ name: " " }))).toMatchObject({ status: "error", fieldErrors: { name: expect.any(String) } });
    harness.issueError = new PlanRequiredError("ai_front_desk");
    expect(await issueWorkforceTokenAction(initialIssueTokenState, form({ name: "Workforce" }))).toMatchObject({ status: "error", message: expect.stringContaining("Pro") });
    expect(harness.issued).toEqual([]);
  });

  it("revoking works on any plan for owners and managers, and is audited", async () => {
    signIn("manager", ESSENTIALS);
    harness.rpcResult = { data: true, error: null };
    const id = "77777777-7777-4777-8777-777777777777";
    expect(await redirectOf(() => revokeAgentTokenAction(form({ tokenId: id })))).toBe("/app/settings/ai-front-desk?done=revoked#tokens");
    expect(harness.rpcCalls).toEqual([{ name: "revoke_agent_token", args: { p_token_id: id } }]);
    expect(harness.audits.map((entry) => entry.action)).toEqual(["agent_token.revoked"]);
    expect(await redirectOf(() => revokeAgentTokenAction(form({ tokenId: "not-a-uuid" })))).toBe("/app/settings/ai-front-desk?error=save_failed");
    signIn("front_desk");
    expect(await redirectOf(() => revokeAgentTokenAction(form({ tokenId: id })))).toBe("/app/settings/ai-front-desk?error=manage_only");
  });
});
