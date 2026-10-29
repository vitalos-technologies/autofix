import "server-only";

import { NextResponse } from "next/server";
import type { z } from "zod";
import {
  AGENT_PRO_FEATURE,
  AGENT_USAGE_MAX_AGE_DAYS,
  agentErrorMessages,
  agentErrorStatus,
  agentInputSchemas,
  ASKBRIDGE_TOOLS,
  type AgentCallSummaryReport,
  type AgentUsageReport,
  type AgentBookingStatus,
  type AgentCreatedBooking,
  type AgentError,
  type AgentErrorCode,
  type AgentGarageProfile,
  type AgentService,
  type AgentSlot,
  type AgentTool,
  type AgentVehicle,
} from "@/lib/agent-api/schemas";
import { getAgentApiStore, type AgentGarageRecord, type AgentTokenRecord } from "@/lib/agent-api/store";
import { AgentTokenConfigError, agentTokenHashesMatch, bearerToken, hashAgentToken, tokenAllows } from "@/lib/agent-api/tokens";
import { getBookingEngine } from "@/lib/booking-engine";
import { BookingEngineError } from "@/lib/booking-engine/errors";
import { MAX_JSON_BYTES } from "@/lib/booking-engine/http";
import type { OnlineService, Slot } from "@/lib/booking-engine/types";
import { maskRegistrations } from "@/lib/platform/policy";
import { hasFeature } from "@/lib/plans/entitlements";
import { consumeRateLimit } from "@/lib/rate-limit";
import { garageUrl } from "@/lib/tenancy/urls";
import { getConfiguredVehicleProvider } from "@/lib/vehicle/configured-provider";
import { withMotVisibility } from "@/lib/vehicle/mot";
import { VehicleLookupError } from "@/lib/vehicle/provider";
import { formatRegistration } from "@/lib/vehicle/registration";

// Agent tool API (`POST /api/agent/v1/<tool>`, docs/autofix/agent-api.yaml).
//
// Every call: bearer token → HMAC hash → agent_tokens row (constant-time
// check, not revoked, not expired (voice desk per-call tokens), garage taking bookings) → plan (P5.12: a `workforce`
// token, the AI front desk, needs Pro: 403 PLAN_REQUIRED; an `askbridge`
// token, the Essentials website chat, only reads) → tool scope → per-token and
// per-garage rate limits → strict zod body → tool → one agent_call_log row and
// one structured log line (garage, token id, tool, outcome, status, latency;
// never phone numbers, registrations or tokens). The garage is the token's;
// a garage id in the body is rejected by the strict schemas.

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** Garage statuses that take bookings (the same ones whose booking site is served). */
const ACTIVE_GARAGE_STATUSES = new Set(["active", "onboarding"]);

/** Requests per window for every call, per token and per garage. */
export const AGENT_RATE_LIMITS = {
  token: { limit: 120, windowSeconds: 60 },
  garage: { limit: 600, windowSeconds: 60 },
} as const;

/** Extra limits on tools that cost money or could be used to guess references. */
const TOOL_RATE_LIMITS: Partial<Record<AgentTool, { limit: number; windowSeconds: number; per: "token" | "garage" }>> = {
  lookup_vehicle: { limit: 300, windowSeconds: 600, per: "garage" },
  create_booking: { limit: 30, windowSeconds: 600, per: "token" },
  get_booking: { limit: 30, windowSeconds: 600, per: "token" },
  report_usage: { limit: 600, windowSeconds: 600, per: "token" },
  log_call_summary: { limit: 10, windowSeconds: 600, per: "token" },
};

/** A usage report may be dated at most this far ahead of the server clock. */
const USAGE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type ToolResult = { status: number; body: unknown; outcome: "OK" | AgentErrorCode; bookingId?: string | null };
type ToolContext = { token: AgentTokenRecord; garageId: string; now: Date };

function errorBody(code: AgentErrorCode, extra: Partial<AgentError> = {}): AgentError {
  return { code, message: agentErrorMessages[code], ...extra };
}

function fail(code: AgentErrorCode, extra: Partial<AgentError> = {}): ToolResult {
  return { status: agentErrorStatus[code], body: errorBody(code, extra), outcome: code };
}

function ok(body: unknown, status = 200, bookingId?: string): ToolResult {
  return { status, body, outcome: "OK", bookingId };
}

function respond(result: Pick<ToolResult, "status" | "body">, headers: Record<string, string> = {}) {
  const extra: Record<string, string> = result.status === 429 ? { "Retry-After": "60" } : result.status === 503 ? { "Retry-After": "30" } : {};
  if (result.status === 401) extra["WWW-Authenticate"] = 'Bearer realm="autofix-agent"';
  return NextResponse.json(result.body, { status: result.status, headers: { ...NO_STORE, ...extra, ...headers } });
}

/** Field paths and messages only, never the submitted values. */
function issues(error: z.ZodError) {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function engineCode(error: unknown): AgentErrorCode {
  if (error instanceof BookingEngineError) {
    if (error.code === "RATE_LIMITED" || error.code === "TURNSTILE_FAILED") return "UNAVAILABLE";
    return error.code;
  }
  return "UNAVAILABLE";
}

function log(entry: Record<string, unknown>) {
  console.info(JSON.stringify({ event: "agent_api.call", ...entry }));
}

type Body = { ok: true; value: unknown } | { ok: false; code: "INVALID_JSON" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" };

/** JSON only; an empty body is `{}` (for the tools that take no input). */
async function readBody(request: Request): Promise<Body> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return { ok: false, code: "PAYLOAD_TOO_LARGE" };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) return { ok: false, code: "PAYLOAD_TOO_LARGE" };
  if (!text.trim()) return { ok: true, value: {} };
  if (!/^application\/json\b/i.test((request.headers.get("content-type") ?? "").trim())) return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }
}

function gbp(pence: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

export function agentService(service: OnlineService): AgentService {
  const pricePence = service.priceMode === "quote" ? null : service.pricePence;
  const priceText = pricePence === null ? "Price on quote" : service.priceMode === "from" ? `from ${gbp(pricePence)}` : gbp(pricePence);
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    durationMin: service.durationMin,
    priceMode: pricePence === null ? "quote" : service.priceMode,
    pricePence,
    priceText,
    locationMode: service.locationMode,
    isMot: service.isMot,
    minNoticeHours: service.minNoticeH,
    maxDaysAhead: service.maxDaysAhead,
  };
}

/** The `garage_profile` response for a garage record. Shared with the Askbridge knowledge sync (P4.6). */
export function agentGarageProfile(garage: AgentGarageRecord): AgentGarageProfile {
  return {
    garage: {
      name: garage.name,
      phone: garage.phone,
      whatsapp: garage.whatsapp,
      email: garage.email,
      address: {
        line1: garage.address.line1 ?? null,
        line2: garage.address.line2 ?? null,
        town: garage.address.town ?? null,
        postcode: garage.address.postcode ?? null,
      },
      timezone: garage.timezone,
      bookingUrl: garageUrl({ slug: garage.slug, customDomain: garage.customDomain }, "/"),
      motEnabled: garage.motEnabled,
    },
    openingHours: garage.openingHours.map((entry) => ({ ...entry, day: DAYS[entry.weekday - 1] ?? "" })),
    closures: garage.closures,
    policies: {
      cancellationCutoffHours: garage.cancellationCutoffH,
      agentBookingsNeedConfirmation: true,
      onlineBookingsNeedApproval: garage.approveOnline,
      mobileServiceArea: garage.serviceArea,
      humanCallbackAvailable: true,
    },
    faqs: garage.faqs,
  };
}

const slot = (value: Slot): AgentSlot => ({ startsAt: value.startsAt, endsAt: value.endsAt });

function localDate(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(at);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools: { [T in AgentTool]: (input: z.output<(typeof agentInputSchemas)[T]>, context: ToolContext) => Promise<ToolResult> } = {
  async lookup_vehicle(input, { token }) {
    const provider = getConfiguredVehicleProvider();
    if (!provider) return fail("UNAVAILABLE");
    try {
      // MOT data only when this garage shows MOT.
      const details = withMotVisibility(await provider.lookup(input.registration), token.garage.motEnabled);
      const vehicle: AgentVehicle = {
        registration: formatRegistration(details.registration || input.registration),
        make: details.make ?? null,
        model: details.model ?? null,
        derivative: details.derivative ?? null,
        year: details.year ?? null,
        colour: details.colour ?? null,
        fuelType: details.fuelType ?? null,
      };
      if (token.garage.motEnabled) {
        vehicle.motStatus = details.motStatus ?? null;
        vehicle.motExpiry = details.motExpiry ?? null;
      }
      return ok({ vehicle });
    } catch (error) {
      const code = error instanceof VehicleLookupError ? error.code : "unavailable";
      if (code === "not_found") return fail("VEHICLE_NOT_FOUND");
      if (code === "invalid") return fail("INVALID_REQUEST", { issues: [{ path: "registration", message: "Enter a valid UK registration" }] });
      if (code === "rate_limited") return fail("RATE_LIMITED");
      return fail("UNAVAILABLE");
    }
  },

  async list_services(_input, { garageId }) {
    const services = await getBookingEngine().listOnlineServices(garageId);
    return ok({ services: services.map(agentService) });
  },

  async available_slots(input, { garageId, token }) {
    const slots = await getBookingEngine().getAvailableSlots({
      garageId,
      serviceId: input.serviceId,
      from: input.from,
      to: input.to,
      locationMode: input.locationMode,
    });
    return ok({ timezone: token.garage.timezone, slots: slots.filter((candidate) => candidate.freeCount > 0).map(slot) });
  },

  async create_booking(input, { garageId }) {
    // Always a request for staff to confirm: source ai_agent makes create_booking() store `requested`.
    const result = await getBookingEngine().createBooking(garageId, {
      ...input,
      customer: { ...input.customer, reminderConsent: false },
      source: "ai_agent",
    });
    if (!result.ok) {
      const code: AgentErrorCode = result.code === "RATE_LIMITED" || result.code === "TURNSTILE_FAILED" ? "UNAVAILABLE" : result.code;
      return fail(code, code === "SLOT_UNAVAILABLE" ? { alternatives: (result.alternatives ?? []).map(slot) } : {});
    }
    const { reference, status, startsAt, endsAt, id } = result.booking;
    const booking: AgentCreatedBooking = { reference, status, startsAt, endsAt };
    return ok({ booking, replayed: result.replayed }, result.replayed ? 200 : 201, id);
  },

  async get_booking(input, { garageId }) {
    const found = await getAgentApiStore().findBooking(garageId, input.reference, input.registration);
    if (!found) return fail("NOT_FOUND");
    const booking: AgentBookingStatus = {
      reference: found.reference,
      status: found.status,
      startsAt: found.startsAt,
      endsAt: found.endsAt,
      locationMode: found.locationMode,
      service: { name: found.service.name },
      vehicle: { make: found.vehicle.make, model: found.vehicle.model },
      customerFirstName: found.customerFirstName,
      canChangeOnline: found.canChange,
      changeDeadline: found.changeDeadline,
    };
    return ok({ booking });
  },

  async garage_profile(_input, { garageId, token, now }) {
    const garage = await getAgentApiStore().garageProfile(garageId, localDate(now, token.garage.timezone));
    if (!garage) return fail("GARAGE_INACTIVE");
    return ok(agentGarageProfile(garage));
  },

  // P5.12: AI front desk minutes for one conversation. Counted once per conversation id; never
  // blocks at the allowance (the month close records any overage).
  async report_usage(input, { garageId, now }) {
    const endedAt = new Date(input.endedAt);
    const oldest = now.getTime() - AGENT_USAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    if (endedAt.getTime() > now.getTime() + USAGE_CLOCK_SKEW_MS || endedAt.getTime() < oldest) {
      return fail("INVALID_REQUEST", { issues: [{ path: "endedAt", message: `Report a conversation that ended in the last ${AGENT_USAGE_MAX_AGE_DAYS} days` }] });
    }
    const result = await getAgentApiStore().recordAiMinutes({ garageId, conversationId: input.conversationId, minutes: input.minutes, endedAt });
    if (result.status === "failed") return fail("UNAVAILABLE");
    const usage: AgentUsageReport = {
      conversationId: input.conversationId,
      channel: input.channel,
      minutes: result.minutes,
      replayed: result.status === "replayed",
    };
    return ok({ usage }, usage.replayed ? 200 : 201);
  },

  // Voice desk: the AI front desk's note on the call this token was minted for. Registrations are masked
  // (registration privacy): the booking request already carries the car.
  async log_call_summary(input, { garageId, token }) {
    if (!token.callSid || token.callSid !== input.callSid) return fail("FORBIDDEN");
    const stored = await getAgentApiStore().recordCallSummary({ garageId, callSid: input.callSid, summary: maskRegistrations(input.summary), outcome: input.outcome });
    const report: AgentCallSummaryReport = { callSid: input.callSid, outcome: input.outcome, stored };
    return ok(report, stored ? 201 : 200);
  },
};

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function authenticate(request: Request): Promise<{ token: AgentTokenRecord } | { error: AgentErrorCode }> {
  const raw = bearerToken(request.headers.get("authorization"));
  if (!raw) return { error: "UNAUTHORIZED" };
  let hash: string;
  try {
    hash = hashAgentToken(raw);
  } catch (error) {
    return { error: error instanceof AgentTokenConfigError ? "UNAVAILABLE" : "UNAUTHORIZED" };
  }
  let token: AgentTokenRecord | null;
  try {
    token = await getAgentApiStore().findToken(hash);
  } catch {
    return { error: "UNAVAILABLE" };
  }
  if (!token || !agentTokenHashesMatch(token.tokenHash, hash) || token.revokedAt) return { error: "UNAUTHORIZED" };
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return { error: "UNAUTHORIZED" };
  return { token };
}

async function withinLimits(tool: AgentTool, token: AgentTokenRecord) {
  if (!(await consumeRateLimit(token.id, "agent_token", AGENT_RATE_LIMITS.token.limit, AGENT_RATE_LIMITS.token.windowSeconds))) return false;
  if (!(await consumeRateLimit(token.garageId, "agent_garage", AGENT_RATE_LIMITS.garage.limit, AGENT_RATE_LIMITS.garage.windowSeconds))) return false;
  const extra = TOOL_RATE_LIMITS[tool];
  if (!extra) return true;
  return consumeRateLimit(extra.per === "token" ? token.id : token.garageId, `agent_${tool}`, extra.limit, extra.windowSeconds);
}

async function runTool(tool: AgentTool, request: Request, token: AgentTokenRecord, now: Date): Promise<ToolResult> {
  if (!ACTIVE_GARAGE_STATUSES.has(token.garage.status)) return fail("GARAGE_INACTIVE");
  // D17: the AI front desk (Workforce) is Pro; the Askbridge chat stays on Essentials with read-only tools.
  if (token.audience === "workforce" && !hasFeature(token.garage.plan, AGENT_PRO_FEATURE, now)) {
    return fail("PLAN_REQUIRED", { feature: AGENT_PRO_FEATURE, plan: "pro" });
  }
  if (token.audience === "askbridge" && !ASKBRIDGE_TOOLS.includes(tool)) return fail("FORBIDDEN");
  if (!tokenAllows(token.scopes, tool)) return fail("FORBIDDEN");
  if (!(await withinLimits(tool, token))) return fail("RATE_LIMITED");

  const body = await readBody(request);
  if (!body.ok) return fail(body.code);
  const parsed = agentInputSchemas[tool].safeParse(body.value);
  if (!parsed.success) return fail(tool === "create_booking" ? "INVALID_BOOKING" : "INVALID_REQUEST", { issues: issues(parsed.error) });

  try {
    const handler = tools[tool] as (input: unknown, context: ToolContext) => Promise<ToolResult>;
    return await handler(parsed.data, { token, garageId: token.garageId, now });
  } catch (error) {
    return fail(engineCode(error));
  }
}

/** Runs one agent tool call end to end. The routes under `src/app/api/agent/v1/` are one line each. */
export async function handleAgentToolRequest(tool: AgentTool, request: Request, clock: () => number = () => performance.now()): Promise<NextResponse> {
  const started = clock();
  const auth = await authenticate(request);
  if ("error" in auth) {
    // No garage is known yet, so there is no audit row; the log line has no token.
    log({ tool, outcome: auth.error, status: agentErrorStatus[auth.error], latency_ms: Math.round(clock() - started) });
    return respond({ status: agentErrorStatus[auth.error], body: errorBody(auth.error) });
  }

  const { token } = auth;
  const result = await runTool(tool, request, token, new Date());
  const latencyMs = Math.max(0, Math.round(clock() - started));
  await getAgentApiStore().recordCall({
    garageId: token.garageId,
    tokenId: token.id,
    tool,
    outcome: result.outcome,
    httpStatus: result.status,
    latencyMs,
    bookingId: result.bookingId ?? null,
  });
  log({ garage_id: token.garageId, token_id: token.id, tool, outcome: result.outcome, status: result.status, latency_ms: latencyMs });
  return respond(result);
}
