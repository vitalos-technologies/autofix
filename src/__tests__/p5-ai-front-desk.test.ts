/**
 * P5.12 AI front desk on Pro: the Workforce hand-off hook in the Twilio voice webhook (Essentials
 * unchanged, Pro with the switch on hands missed calls to Workforce, an unanswered Workforce leg
 * falls back to voicemail + text-back), the hand-off helpers, the settings actions' plan and role
 * gates, and the usage month shared with the Plan page (clock-change edges).
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
import { AI_FRONT_DESK_ENV, parseWorkforceVoiceTarget, workforceConnectionStatus, workforceSipUri, workforceVoiceTarget } from "@/lib/ai-front-desk/hand-off";
import { usageMonthFirst, workforceConnection, type AgentTokenRow } from "@/lib/ai-front-desk/server";
import { localDateKey, monthStart } from "@/lib/admin/dates";
import { agentDialTwiml, isVoiceStep } from "@/lib/calls/twiml";
import { computeTwilioSignature } from "@/lib/messaging/twilio";
import { handleTwilioWebhook, type CallRecord, type TwilioWebhookRepo } from "@/lib/messaging/twilio-webhooks";
import { PlanRequiredError } from "@/lib/plans/entitlements";

// ---------------------------------------------------------------------------
// Hand-off helpers
// ---------------------------------------------------------------------------

const SIP = "sip:frontdesk@workforce.example.com";
const GARAGE = "a0000000-0000-4000-8000-00000000000a";
const CALL = "CA00000000000000000000000000000001";

describe("Workforce voice target", () => {
  it("accepts only sip:/sips: URIs from WORKFORCE_VOICE_SIP_URI", () => {
    expect(parseWorkforceVoiceTarget(SIP)).toEqual({ sipUri: SIP });
    expect(parseWorkforceVoiceTarget(" sips:agent@sip.workforce.example:5061;transport=tls ")).toEqual({ sipUri: "sips:agent@sip.workforce.example:5061;transport=tls" });
    for (const bad of ["", "https://workforce.example/voice", "+441302000000", "sip:a@b?X-Injected=1", "sip:a@b\"><Hangup/>", "sip:@host"]) {
      expect(parseWorkforceVoiceTarget(bad), bad).toBeNull();
    }
    expect(workforceVoiceTarget({})).toBeNull();
    expect(workforceVoiceTarget({ [AI_FRONT_DESK_ENV.voiceSipUri]: SIP })).toEqual({ sipUri: SIP });
  });

  it("tells Workforce the garage and the CallSid (its conversationId) as SIP headers, nothing about the caller", () => {
    const uri = workforceSipUri({ sipUri: SIP }, { garageId: GARAGE, callSid: CALL });
    expect(uri).toBe(`${SIP}?X-Autofix-Garage=${GARAGE}&X-Autofix-Call-Sid=${CALL}`);
    const xml = agentDialTwiml({ sipUri: uri, actionUrl: "https://autofix.vitalos.co.uk/api/webhooks/twilio/voice?step=agent" });
    expect(xml).toBe(`<Dial timeout="20" answerOnBridge="true" action="https://autofix.vitalos.co.uk/api/webhooks/twilio/voice?step=agent" method="POST"><Sip>${SIP}?X-Autofix-Garage=${GARAGE}&amp;X-Autofix-Call-Sid=${CALL}</Sip></Dial>`);
    expect(isVoiceStep("agent")).toBe(true);
  });

  it("describes the connection from the garage's tokens", () => {
    expect(workforceConnectionStatus({ voiceConfigured: false, activeTokens: 0, lastUsedAt: null }).label).toBe("Not connected");
    expect(workforceConnectionStatus({ voiceConfigured: false, activeTokens: 1, lastUsedAt: null }).label).toBe("Waiting for Workforce");
    expect(workforceConnectionStatus({ voiceConfigured: true, activeTokens: 1, lastUsedAt: "2026-10-28T09:00:00Z" })).toMatchObject({ tone: "success", label: "Connected" });
    const token = (overrides: Partial<AgentTokenRow>): AgentTokenRow => ({ id: "t", name: "n", audience: "workforce", scopes: [], lastUsedAt: null, revokedAt: null, createdAt: "2026-10-01T00:00:00Z", ...overrides });
    expect(workforceConnection([
      token({ lastUsedAt: "2026-10-27T09:00:00Z" }),
      token({ lastUsedAt: "2026-10-28T09:00:00Z", revokedAt: "2026-10-28T10:00:00Z" }),
      token({ audience: "askbridge", lastUsedAt: "2026-10-28T11:00:00Z" }),
      token({}),
    ], {})).toEqual({ voiceConfigured: false, activeTokens: 2, lastUsedAt: "2026-10-27T09:00:00Z" });
  });
});

// ---------------------------------------------------------------------------
// Voice webhook hook point
// ---------------------------------------------------------------------------

const AUTH_TOKEN = "twilio-test-auth-token-0123456789";
const BASE = "https://autofix.vitalos.co.uk";
const ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL: BASE };
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

function voiceRepo(options: { handOff?: boolean | "throws"; dialTarget?: string; withHook?: boolean } = {}) {
  const events = new Set<string>();
  const state = { calls: new Map<string, CallRecord & { id: string }>(), textBacks: [] as string[], handOffChecks: 0 };
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
    async queueTextBack(_garageId, callId) { state.textBacks.push(callId); },
  };
  if (options.withHook !== false) {
    repo.aiFrontDeskHandOff = async () => {
      state.handOffChecks += 1;
      if (options.handOff === "throws") throw new Error("database down");
      return options.handOff ?? false;
    };
    repo.findCallId = async (_garageId, callSid) => state.calls.get(callSid)?.id ?? null;
  }
  return { repo, state };
}

const deps = (repo: TwilioWebhookRepo, target: string | null = SIP) => ({ repo: () => repo, env: ENV, workforceVoiceTarget: target ? { sipUri: target } : null });

describe("voice webhook: Essentials keeps missed-call text-back and voicemail", () => {
  it("an Essentials garage (hand-off false) gets the voicemail and the text-back even with Workforce configured", async () => {
    const { repo, state } = voiceRepo({ handOff: false });
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo))).text();
    expect(xml).toContain("<Record ");
    expect(xml).not.toContain("<Sip>");
    expect(state.textBacks).toEqual([`call-${CALL}`]);
    expect(state.handOffChecks).toBe(1);
  });

  it("a repo without the hook, no Workforce target, or a failing check: unchanged", async () => {
    for (const [setup, target] of [[{ withHook: false, handOff: true }, SIP], [{ handOff: true }, null], [{ handOff: "throws" }, SIP]] as const) {
      const { repo, state } = voiceRepo(setup);
      const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo, target))).text();
      expect(xml).toContain("<Record ");
      expect(state.textBacks).toEqual([`call-${CALL}`]);
    }
  });

  it("the garage's own phone still rings first; the hand-off is not even asked", async () => {
    const { repo, state } = voiceRepo({ handOff: true, dialTarget: OWN_PHONE });
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo))).text();
    expect(xml).toContain(`<Number>${OWN_PHONE}</Number>`);
    expect(state.handOffChecks).toBe(0);
  });
});

describe("voice webhook: Pro with the AI front desk on hands missed calls to Workforce", () => {
  it("a missed call goes to the Workforce SIP target, is logged missed, and gets no text-back", async () => {
    const { repo, state } = voiceRepo({ handOff: true });
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo))).text();
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" answerOnBridge="true" action="${BASE}/api/webhooks/twilio/voice?step=agent" method="POST"><Sip>${SIP}?X-Autofix-Garage=${GARAGE}&amp;X-Autofix-Call-Sid=${CALL}</Sip></Dial></Response>`);
    expect(xml).not.toContain(CALLER);
    expect(state.calls.get(CALL)).toMatchObject({ missed: true });
    expect(state.textBacks).toEqual([]);
  });

  it("after the garage's phone goes unanswered the call goes to Workforce", async () => {
    const { repo, state } = voiceRepo({ handOff: true, dialTarget: OWN_PHONE });
    await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo));
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("in-progress", { DialCallStatus: "no-answer" }), "?step=dial"), "voice", deps(repo))).text();
    expect(xml).toContain("<Sip>");
    expect(state.textBacks).toEqual([]);
  });

  it.each(["no-answer", "busy", "failed", "canceled"])("a %s Workforce leg falls back to the voicemail and the text-back, once", async (status) => {
    const { repo, state } = voiceRepo({ handOff: true });
    await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo));
    const request = () => signedVoice(callParams("in-progress", { DialCallStatus: status }), "?step=agent");
    const xml = await (await handleTwilioWebhook(request(), "voice", deps(repo))).text();
    expect(xml).toContain("<Record ");
    expect(state.textBacks).toEqual([`call-${CALL}`]);
    await handleTwilioWebhook(request(), "voice", deps(repo));
    expect(state.textBacks).toHaveLength(1);
  });

  it("an answered Workforce leg just hangs up afterwards", async () => {
    const { repo, state } = voiceRepo({ handOff: true });
    await handleTwilioWebhook(signedVoice(callParams("ringing")), "voice", deps(repo));
    const xml = await (await handleTwilioWebhook(signedVoice(callParams("in-progress", { DialCallStatus: "completed" }), "?step=agent"), "voice", deps(repo))).text();
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
