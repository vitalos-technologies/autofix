/**
 * P4.2 contract tests: real `/api/agent/v1/*` handler responses (and the
 * OpenAPI examples) are validated against docs/autofix/agent-api.yaml.
 * The store, booking engine, vehicle provider and rate limiter are in memory.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedBooking } from "@/lib/booking-engine/manage";
import type { OnlineService } from "@/lib/booking-engine/types";
import type { VehicleDetails } from "@/types/domain";
import { ajv, documentedStatuses, expectMatchesSpec, operation, requestValidator, spec } from "./support/agent-api-spec";
import { fakeEngine } from "./support/booking-routes";

const harness = vi.hoisted(() => ({
  blockedScopes: new Set<string>(),
  lookup: vi.fn(async (registration: string): Promise<VehicleDetails> => ({ registration, make: "Vauxhall", model: "Astra", colour: "Blue", fuelType: "Petrol", year: 2016, motStatus: "Valid", motExpiry: "2027-03-01" })),
  providerConfigured: true,
}));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async (_identifier: string, scope: string) => !harness.blockedScopes.has(scope)),
}));
vi.mock("@/lib/vehicle/configured-provider", () => ({
  getConfiguredVehicleProvider: () => (harness.providerConfigured ? { lookup: harness.lookup } : null),
}));

import { POST as availableSlots } from "@/app/api/agent/v1/available_slots/route";
import { POST as createBooking } from "@/app/api/agent/v1/create_booking/route";
import { POST as garageProfile } from "@/app/api/agent/v1/garage_profile/route";
import { POST as getBooking } from "@/app/api/agent/v1/get_booking/route";
import { POST as listServices } from "@/app/api/agent/v1/list_services/route";
import { POST as lookupVehicle } from "@/app/api/agent/v1/lookup_vehicle/route";
import { POST as logCallSummary } from "@/app/api/agent/v1/log_call_summary/route";
import { POST as reportUsage } from "@/app/api/agent/v1/report_usage/route";
import { agentInputSchemas, agentTools, type AgentTool } from "@/lib/agent-api/schemas";
import { setAgentApiStoreForTests, type AgentApiStore, type AgentCallEntry, type AgentGarageRecord, type AgentTokenRecord, type AiMinutesResult } from "@/lib/agent-api/store";
import { hashAgentToken } from "@/lib/agent-api/tokens";
import { setBookingEngineForTests } from "@/lib/booking-engine";
import { VehicleLookupError } from "@/lib/vehicle/provider";

// ---------------------------------------------------------------------------
// In-memory world
// ---------------------------------------------------------------------------

const GARAGE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GARAGE_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = `afat_${"A".repeat(43)}`;
const NARROW_TOKEN = `afat_${"B".repeat(43)}`;
const REVOKED_TOKEN = `afat_${"C".repeat(43)}`;
const SUSPENDED_TOKEN = `afat_${"D".repeat(43)}`;
const CALL_TOKEN = `afat_${"E".repeat(43)}`;
const EXPIRED_CALL_TOKEN = `afat_${"F".repeat(43)}`;
const CALL_SID = "CA0123456789abcdef0123456789abcdef";
const PRO = { plan: "pro", trialEndsAt: null, planChosen: "pro" } as const;
const ESSENTIALS = { plan: "essentials", trialEndsAt: null, planChosen: "essentials" } as const;

function tokenRecord(raw: string, overrides: Partial<AgentTokenRecord> = {}): AgentTokenRecord {
  return {
    id: `tok-${raw.slice(5, 6)}`,
    garageId: GARAGE_ID,
    tokenHash: hashAgentToken(raw),
    scopes: [...agentTools],
    audience: "workforce",
    revokedAt: null,
    garage: { status: "active", motEnabled: true, timezone: "Europe/London", plan: PRO },
    ...overrides,
  };
}

const profile: AgentGarageRecord = {
  name: "Hartley Road Motors",
  slug: "hartley-road",
  customDomain: null,
  phone: "+441302555000",
  whatsapp: null,
  email: "hello@hartley.example",
  address: { line1: "1 Hartley Road", town: "Doncaster", postcode: "DN1 2AB" },
  timezone: "Europe/London",
  motEnabled: true,
  approveOnline: false,
  serviceArea: ["DN1", "DN2"],
  cancellationCutoffH: 24,
  openingHours: [{ weekday: 1, opens: "08:00", closes: "17:30" }, { weekday: 6, opens: "08:30", closes: "13:00" }],
  closures: [{ startsOn: "2026-12-25", endsOn: "2026-12-26", reason: "Christmas" }],
  faqs: [{ question: "Do you do courtesy cars?", answer: "Yes, book one with your service." }],
};

const managed: ManagedBooking = {
  id: "55555555-5555-4555-8555-555555555555",
  garageId: GARAGE_ID,
  reference: "HRM-4821",
  status: "requested",
  startsAt: "2026-11-03T10:00:00.000Z",
  endsAt: "2026-11-03T11:00:00.000Z",
  locationMode: "workshop",
  service: { id: SERVICE_ID, name: "Full service" },
  vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
  customerFirstName: "Sam",
  customerName: "Sam Patel",
  customerPhone: "+447700900123",
  postcode: null,
  canChange: true,
  changeDeadline: "2026-11-02T10:00:00.000Z",
  blockedReason: null,
  serviceId: SERVICE_ID,
  resourceId: null,
  resourceKind: "bay",
  during: null,
  timeZone: "Europe/London",
  idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
  manageTokenHash: "a".repeat(64),
};

const calls: AgentCallEntry[] = [];
const tokens = new Map<string, AgentTokenRecord>();
const store: AgentApiStore = {
  findToken: vi.fn(async (hash: string) => tokens.get(hash) ?? null),
  recordCall: vi.fn(async (entry: AgentCallEntry) => { calls.push(entry); }),
  garageProfile: vi.fn(async (garageId: string) => (garageId === GARAGE_ID ? profile : null)),
  findBooking: vi.fn(async (garageId: string, reference: string, registration: string) =>
    garageId === GARAGE_ID && reference === "HRM-4821" && registration === "AB12CDE" ? managed : null),
  recordAiMinutes: vi.fn(async ({ garageId, conversationId, minutes }: { garageId: string; conversationId: string; minutes: number }): Promise<AiMinutesResult> => {
    const key = `${garageId}:ai:${conversationId}`;
    const stored = usage.get(key);
    if (stored !== undefined) return { status: "replayed", minutes: stored };
    usage.set(key, minutes);
    return { status: "recorded", minutes };
  }),
  recordCallSummary: vi.fn(async ({ callSid }: { callSid: string }) => {
    if (summaries.has(callSid)) return false;
    summaries.add(callSid);
    return true;
  }),
};
const summaries = new Set<string>();
const usage = new Map<string, number>();

const services: OnlineService[] = [
  { id: SERVICE_ID, name: "Full service", description: "Oil, filters, checks", durationMin: 120, bufferMin: 15, pricePence: 18900, priceMode: "fixed", locationMode: "workshop", isMot: false, needsApproval: false, minNoticeH: 2, maxDaysAhead: 60, sort: 1 },
  { id: "44444444-4444-4444-8444-444444444444", name: "Diagnostics", description: "", durationMin: 60, bufferMin: 0, pricePence: 4500, priceMode: "from", locationMode: "both", isMot: false, needsApproval: false, minNoticeH: 2, maxDaysAhead: 60, sort: 2 },
  { id: "66666666-6666-4666-8666-666666666666", name: "Something else", description: "Tell us", durationMin: 60, bufferMin: 0, pricePence: 9900, priceMode: "quote", locationMode: "workshop", isMot: false, needsApproval: true, minNoticeH: 2, maxDaysAhead: 60, sort: 3 },
];

const engine = fakeEngine();

const routes: Record<AgentTool, (request: Request) => Promise<Response>> = {
  lookup_vehicle: lookupVehicle,
  list_services: listServices,
  available_slots: availableSlots,
  create_booking: createBooking,
  get_booking: getBooking,
  garage_profile: garageProfile,
  report_usage: reportUsage,
  log_call_summary: logCallSummary,
};

function agentRequest(tool: AgentTool, body: unknown, init: { token?: string | null; contentType?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": init.contentType ?? "application/json" };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(`https://pitline.co.uk/api/agent/v1/${tool}`, {
    method: "POST",
    headers,
    body: init.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

/** Calls the real route and checks the response against the spec; returns status and body. */
async function call(tool: AgentTool, body: unknown, init: Parameters<typeof agentRequest>[2] = {}) {
  const response = await routes[tool](agentRequest(tool, body, init));
  const json = (await response.json()) as Record<string, unknown>;
  expect(documentedStatuses(tool).concat([400, 413, 415]), `${tool} returned an undocumented status ${response.status}`).toContain(response.status);
  expectMatchesSpec(tool, response.status, json);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body: json, headers: response.headers };
}

const bookingBody = {
  serviceId: SERVICE_ID,
  startsAt: "2026-11-03T10:00:00.000Z",
  locationMode: "workshop",
  symptoms: ["Warning light"],
  customer: { name: "Sam Patel", phone: "07700 900123", channel: "sms" },
  vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
  idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
};

const created = {
  ok: true,
  replayed: false,
  booking: {
    id: managed.id,
    reference: "HRM-4821",
    status: "requested",
    startsAt: "2026-11-03T10:00:00.000Z",
    endsAt: "2026-11-03T11:00:00.000Z",
    customerId: "77777777-7777-4777-8777-777777777777",
    vehicleId: "88888888-8888-4888-8888-888888888888",
    manageToken: "x".repeat(43),
  },
};

const logLines: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  logLines.length = 0;
  usage.clear();
  summaries.clear();
  harness.blockedScopes = new Set();
  harness.providerConfigured = true;
  tokens.clear();
  for (const record of [
    tokenRecord(TOKEN),
    tokenRecord(NARROW_TOKEN, { scopes: ["list_services", "garage_profile"] }),
    tokenRecord(REVOKED_TOKEN, { revokedAt: "2026-10-01T00:00:00.000Z" }),
    tokenRecord(SUSPENDED_TOKEN, { garage: { status: "suspended", motEnabled: false, timezone: "Europe/London", plan: PRO } }),
    tokenRecord(CALL_TOKEN, { callSid: CALL_SID, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    tokenRecord(EXPIRED_CALL_TOKEN, { callSid: CALL_SID, expiresAt: new Date(Date.now() - 1_000).toISOString() }),
  ]) tokens.set(record.tokenHash, record);
  engine.listOnlineServices.mockResolvedValue(services);
  engine.getAvailableSlots.mockResolvedValue([
    { startsAt: "2026-11-03T08:00:00.000Z", endsAt: "2026-11-03T10:00:00.000Z", freeCount: 2 },
    { startsAt: "2026-11-03T08:15:00.000Z", endsAt: "2026-11-03T10:15:00.000Z", freeCount: 0 },
    { startsAt: "2026-11-03T08:30:00.000Z", endsAt: "2026-11-03T10:30:00.000Z", freeCount: 1 },
  ]);
  engine.createBooking.mockResolvedValue(created);
  setBookingEngineForTests(engine);
  setAgentApiStoreForTests(store);
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { logLines.push(String(line)); });
});

afterAll(() => {
  setBookingEngineForTests(null);
  setAgentApiStoreForTests(null);
});

// ---------------------------------------------------------------------------
// The document itself
// ---------------------------------------------------------------------------

describe("docs/autofix/agent-api.yaml", () => {
  it("is OpenAPI 3.1 with one POST operation per tool and a route file for each", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).sort()).toEqual(agentTools.map((tool) => `/${tool}`).sort());
    for (const tool of agentTools) {
      expect(Object.keys(spec.paths[`/${tool}`]!)).toEqual(["post"]);
      expect(operation(tool).operationId).toBe(tool);
      expect(existsSync(path.join(process.cwd(), `src/app/api/agent/v1/${tool}/route.ts`))).toBe(true);
      for (const status of [401, 403, 422, 429, 503]) expect(documentedStatuses(tool)).toContain(status);
    }
  });

  it("every schema compiles and every request example is accepted by both the spec and the route's zod schema", () => {
    for (const tool of agentTools) {
      const validate = requestValidator(tool);
      const example = operation(tool).requestBody?.content["application/json"]?.example;
      expect(example, `${tool} has a request example`).toBeDefined();
      expect(validate(example), `${tool}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(agentInputSchemas[tool].safeParse(example).success, `${tool} zod accepts the example`).toBe(true);
    }
  });

  it("spec and zod agree on what they reject: a garage id, a source, consent, or a registration-free lookup", () => {
    const rejected: Array<[AgentTool, unknown]> = [
      ["list_services", { garageId: OTHER_GARAGE_ID }],
      ["garage_profile", { garage_id: OTHER_GARAGE_ID }],
      ["lookup_vehicle", {}],
      ["lookup_vehicle", { registration: "AB12CDE", garageId: OTHER_GARAGE_ID }],
      ["available_slots", { serviceId: "not-a-uuid", from: "2026-11-02", to: "2026-11-03" }],
      ["available_slots", { serviceId: SERVICE_ID, from: "2026-11-02", to: "2026-11-03", garageId: OTHER_GARAGE_ID }],
      ["create_booking", { ...bookingBody, source: "online" }],
      ["create_booking", { ...bookingBody, garageId: OTHER_GARAGE_ID }],
      ["create_booking", { ...bookingBody, status: "confirmed" }],
      ["create_booking", { ...bookingBody, customer: { ...bookingBody.customer, reminderConsent: true } }],
      ["create_booking", { ...bookingBody, customer: { ...bookingBody.customer, offersConsent: true } }],
      ["create_booking", { ...bookingBody, idempotencyKey: undefined }],
      ["get_booking", { reference: "HRM-4821" }],
    ];
    for (const [tool, body] of rejected) {
      const validate = requestValidator(tool);
      const payload = JSON.parse(JSON.stringify(body));
      expect(validate(payload), `${tool} spec should reject ${JSON.stringify(payload)}`).toBe(false);
      expect(agentInputSchemas[tool].safeParse(payload).success, `${tool} zod should reject ${JSON.stringify(payload)}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Handlers against the contract
// ---------------------------------------------------------------------------

describe("authentication and scopes", () => {
  it.each(agentTools)("%s: 401 without a token, with a malformed one, an unknown one or a revoked one", async (tool) => {
    for (const token of [null, "not-a-token", `afat_${"Z".repeat(43)}`, REVOKED_TOKEN]) {
      const result = await call(tool, {}, { token });
      expect(result.status).toBe(401);
      expect(result.body.code).toBe("UNAUTHORIZED");
      expect(result.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect(calls).toEqual([]);
    expect(engine.createBooking).not.toHaveBeenCalled();
  });

  it("403 FORBIDDEN when the token's scopes leave the tool out, and the refusal is audited", async () => {
    const refused = await call("create_booking", bookingBody, { token: NARROW_TOKEN });
    expect(refused).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(engine.createBooking).not.toHaveBeenCalled();
    expect(calls).toEqual([expect.objectContaining({ tool: "create_booking", outcome: "FORBIDDEN", httpStatus: 403, tokenId: "tok-B", garageId: GARAGE_ID })]);
    expect((await call("list_services", {}, { token: NARROW_TOKEN })).status).toBe(200);
  });

  it("403 GARAGE_INACTIVE for a suspended garage", async () => {
    expect(await call("list_services", {}, { token: SUSPENDED_TOKEN })).toMatchObject({ status: 403, body: { code: "GARAGE_INACTIVE" } });
  });

  it("429 with Retry-After when the per-token or per-garage limit is spent", async () => {
    for (const scope of ["agent_token", "agent_garage", "agent_create_booking"]) {
      harness.blockedScopes = new Set([scope]);
      const result = await call("create_booking", bookingBody);
      expect(result).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
      expect(result.headers.get("retry-after")).toBe("60");
    }
    expect(engine.createBooking).not.toHaveBeenCalled();
  });
});

describe("bodies", () => {
  it("415 for a non-JSON body, 400 for broken JSON, 413 for an oversized one; an empty body is {}", async () => {
    expect((await call("lookup_vehicle", undefined, { raw: "registration=AB12CDE", contentType: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await call("lookup_vehicle", undefined, { raw: "{" })).status).toBe(400);
    expect((await call("create_booking", undefined, { raw: JSON.stringify({ ...bookingBody, notes: "x".repeat(40_000) }) })).status).toBe(413);
    expect((await call("list_services", undefined, { raw: "" })).status).toBe(200);
  });

  it("422 lists field paths and never echoes the values sent", async () => {
    const result = await call("create_booking", { ...bookingBody, garageId: OTHER_GARAGE_ID, customer: { ...bookingBody.customer, phone: "1" } });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe("INVALID_BOOKING");
    expect(JSON.stringify(result.body)).not.toContain(OTHER_GARAGE_ID);
    expect(JSON.stringify(result.body)).not.toContain("AB12");
  });
});

describe("lookup_vehicle", () => {
  it("200 with MOT fields for an MOT garage", async () => {
    const result = await call("lookup_vehicle", { registration: "ab12 cde" });
    expect(result.status).toBe(200);
    expect(harness.lookup).toHaveBeenCalledWith("AB12CDE");
    expect(result.body.vehicle).toMatchObject({ registration: "AB12 CDE", make: "Vauxhall", motStatus: "Valid", motExpiry: "2027-03-01" });
  });

  it("drops MOT fields when the garage has MOT off", async () => {
    const record = tokenRecord(TOKEN, { garage: { status: "active", motEnabled: false, timezone: "Europe/London", plan: PRO } });
    tokens.set(record.tokenHash, record);
    const result = await call("lookup_vehicle", { registration: "AB12CDE" });
    expect(result.body.vehicle).not.toHaveProperty("motStatus");
    expect(result.body.vehicle).not.toHaveProperty("motExpiry");
  });

  it("404 VEHICLE_NOT_FOUND, 422 for a bad registration, 503 when lookups are not configured", async () => {
    harness.lookup.mockRejectedValueOnce(new VehicleLookupError("Vehicle not found", "not_found"));
    expect(await call("lookup_vehicle", { registration: "ZZ99ZZZ" })).toMatchObject({ status: 404, body: { code: "VEHICLE_NOT_FOUND" } });
    expect(await call("lookup_vehicle", { registration: "!!" })).toMatchObject({ status: 422, body: { code: "INVALID_REQUEST" } });
    harness.providerConfigured = false;
    expect(await call("lookup_vehicle", { registration: "AB12CDE" })).toMatchObject({ status: 503, body: { code: "UNAVAILABLE" } });
  });
});

describe("list_services", () => {
  it("200 with published prices only: fixed, from, and quote with no figure", async () => {
    const result = await call("list_services", {});
    expect(engine.listOnlineServices).toHaveBeenCalledWith(GARAGE_ID);
    const listed = result.body.services as Array<Record<string, unknown>>;
    expect(listed.map((service) => [service.priceMode, service.pricePence, service.priceText])).toEqual([
      ["fixed", 18900, "£189.00"],
      ["from", 4500, "from £45.00"],
      ["quote", null, "Price on quote"],
    ]);
  });
});

describe("available_slots", () => {
  it("200 with free starts only, for the token's garage", async () => {
    const result = await call("available_slots", { serviceId: SERVICE_ID, from: "2026-11-03", to: "2026-11-03" });
    expect(engine.getAvailableSlots).toHaveBeenCalledWith({ garageId: GARAGE_ID, serviceId: SERVICE_ID, from: "2026-11-03", to: "2026-11-03", locationMode: undefined });
    expect(result.body).toEqual({
      timezone: "Europe/London",
      slots: [
        { startsAt: "2026-11-03T08:00:00.000Z", endsAt: "2026-11-03T10:00:00.000Z" },
        { startsAt: "2026-11-03T08:30:00.000Z", endsAt: "2026-11-03T10:30:00.000Z" },
      ],
    });
  });

  it("422 for more than 14 days or an unknown service", async () => {
    expect((await call("available_slots", { serviceId: SERVICE_ID, from: "2026-11-01", to: "2026-11-20" })).status).toBe(422);
    const { BookingEngineError } = await import("@/lib/booking-engine/errors");
    engine.getAvailableSlots.mockRejectedValueOnce(new BookingEngineError("SERVICE_UNAVAILABLE"));
    expect(await call("available_slots", { serviceId: SERVICE_ID, from: "2026-11-03", to: "2026-11-03" })).toMatchObject({ status: 422, body: { code: "SERVICE_UNAVAILABLE" } });
  });
});

describe("create_booking", () => {
  it("201 requested, as ai_agent, without consent, in the token's garage", async () => {
    const result = await call("create_booking", bookingBody);
    expect(result).toMatchObject({ status: 201, body: { booking: { reference: "HRM-4821", status: "requested" }, replayed: false } });
    expect(result.body.booking).not.toHaveProperty("manageToken");
    const [garageId, input] = engine.createBooking.mock.calls[0]!;
    expect(garageId).toBe(GARAGE_ID);
    expect(input).toMatchObject({ source: "ai_agent", customer: { reminderConsent: false, offersConsent: false }, vehicle: { registration: "AB12CDE" } });
    expect(calls).toEqual([expect.objectContaining({ tool: "create_booking", outcome: "OK", httpStatus: 201, bookingId: managed.id })]);
  });

  it("200 on an idempotent replay", async () => {
    engine.createBooking.mockResolvedValueOnce({ ...created, replayed: true });
    expect(await call("create_booking", bookingBody)).toMatchObject({ status: 200, body: { replayed: true } });
  });

  it("409 SLOT_UNAVAILABLE carries the nearest alternatives", async () => {
    engine.createBooking.mockResolvedValueOnce({
      ok: false,
      code: "SLOT_UNAVAILABLE",
      message: "taken",
      alternatives: [{ startsAt: "2026-11-03T10:15:00.000Z", endsAt: "2026-11-03T11:15:00.000Z", freeCount: 1 }],
    });
    const result = await call("create_booking", bookingBody);
    expect(result).toMatchObject({ status: 409, body: { code: "SLOT_UNAVAILABLE", alternatives: [{ startsAt: "2026-11-03T10:15:00.000Z", endsAt: "2026-11-03T11:15:00.000Z" }] } });
  });

  it("422 for engine refusals (outside the service area, unavailable service)", async () => {
    for (const code of ["OUTSIDE_SERVICE_AREA", "SERVICE_UNAVAILABLE", "INVALID_BOOKING"] as const) {
      engine.createBooking.mockResolvedValueOnce({ ok: false, code, message: "no" });
      expect(await call("create_booking", bookingBody)).toMatchObject({ status: 422, body: { code } });
    }
    engine.createBooking.mockResolvedValueOnce({ ok: false, code: "UNAVAILABLE", message: "down" });
    expect(await call("create_booking", bookingBody)).toMatchObject({ status: 503, body: { code: "UNAVAILABLE" } });
  });
});

describe("get_booking", () => {
  it("200 by reference + registration (any spacing), read only", async () => {
    const result = await call("get_booking", { reference: "hrm-4821", registration: "ab12 cde" });
    expect(store.findBooking).toHaveBeenCalledWith(GARAGE_ID, "HRM-4821", "AB12CDE");
    expect(result.body.booking).toMatchObject({ reference: "HRM-4821", status: "requested", service: { name: "Full service" }, canChangeOnline: true });
    expect(JSON.stringify(result.body)).not.toContain("AB12");
    expect(result.body.booking).not.toHaveProperty("id");
  });

  it("404 NOT_FOUND for a wrong registration", async () => {
    expect(await call("get_booking", { reference: "HRM-4821", registration: "ZZ99ZZZ" })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  });
});

describe("garage_profile", () => {
  it("200 with hours, closures, policies and FAQs", async () => {
    const result = await call("garage_profile", {});
    expect(result.body).toMatchObject({
      garage: { name: "Hartley Road Motors", bookingUrl: "http://hartley-road.localhost:3000/", address: { line1: "1 Hartley Road", line2: null } },
      openingHours: [{ weekday: 1, day: "Monday", opens: "08:00", closes: "17:30" }, { weekday: 6, day: "Saturday" }],
      policies: { agentBookingsNeedConfirmation: true, cancellationCutoffHours: 24, mobileServiceArea: ["DN1", "DN2"] },
      faqs: [{ question: "Do you do courtesy cars?" }],
    });
  });
});

describe("plans (P5.12, D17): the AI front desk is Pro, the Askbridge chat is Essentials", () => {
  const ESSENTIALS_WORKFORCE = `afat_${"E".repeat(43)}`;
  const ESSENTIALS_ASKBRIDGE = `afat_${"F".repeat(43)}`;
  const EXPIRED_TRIAL = `afat_${"G".repeat(43)}`;
  const LEGACY_ASKBRIDGE_WIDE = `afat_${"H".repeat(43)}`;

  beforeEach(() => {
    for (const record of [
      tokenRecord(ESSENTIALS_WORKFORCE, { garage: { status: "active", motEnabled: true, timezone: "Europe/London", plan: ESSENTIALS } }),
      tokenRecord(ESSENTIALS_ASKBRIDGE, { audience: "askbridge", scopes: ["list_services", "available_slots", "garage_profile"], garage: { status: "active", motEnabled: true, timezone: "Europe/London", plan: ESSENTIALS } }),
      tokenRecord(EXPIRED_TRIAL, { garage: { status: "active", motEnabled: true, timezone: "Europe/London", plan: { plan: "pro", trialEndsAt: "2026-01-01T00:00:00.000Z", planChosen: null } } }),
      // Belt and braces: an askbridge token whose scopes somehow name more than the read-only tools.
      tokenRecord(LEGACY_ASKBRIDGE_WIDE, { audience: "askbridge", garage: { status: "active", motEnabled: true, timezone: "Europe/London", plan: ESSENTIALS } }),
    ]) tokens.set(record.tokenHash, record);
  });

  it.each(agentTools)("%s: 403 PLAN_REQUIRED for a workforce token on Essentials, audited, before any work", async (tool) => {
    const body = tool === "create_booking" ? bookingBody : {};
    const result = await call(tool, body, { token: ESSENTIALS_WORKFORCE });
    expect(result).toMatchObject({ status: 403, body: { code: "PLAN_REQUIRED", feature: "ai_front_desk", plan: "pro" } });
    expect(result.body.message).toContain("Pro");
    expect(calls).toEqual([expect.objectContaining({ tool, outcome: "PLAN_REQUIRED", httpStatus: 403, tokenId: "tok-E", garageId: GARAGE_ID })]);
    expect(engine.createBooking).not.toHaveBeenCalled();
    expect(engine.listOnlineServices).not.toHaveBeenCalled();
    expect(store.recordAiMinutes).not.toHaveBeenCalled();
  });

  it("an expired, unconverted trial is Essentials at once", async () => {
    expect(await call("list_services", {}, { token: EXPIRED_TRIAL })).toMatchObject({ status: 403, body: { code: "PLAN_REQUIRED" } });
  });

  it("an askbridge token on Essentials keeps its read-only tools and nothing else", async () => {
    expect((await call("list_services", {}, { token: ESSENTIALS_ASKBRIDGE })).status).toBe(200);
    expect((await call("garage_profile", {}, { token: ESSENTIALS_ASKBRIDGE })).status).toBe(200);
    expect((await call("available_slots", { serviceId: SERVICE_ID, from: "2026-11-03", to: "2026-11-03" }, { token: ESSENTIALS_ASKBRIDGE })).status).toBe(200);
    for (const tool of ["create_booking", "lookup_vehicle", "get_booking", "report_usage"] as const) {
      expect(await call(tool, tool === "create_booking" ? bookingBody : {}, { token: LEGACY_ASKBRIDGE_WIDE })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    }
    expect(engine.createBooking).not.toHaveBeenCalled();
  });

  it("a workforce token on Pro (or a running trial) works as before", async () => {
    expect((await call("list_services", {})).status).toBe(200);
    const trial = tokenRecord(TOKEN, { garage: { status: "active", motEnabled: true, timezone: "Europe/London", plan: { plan: "pro", trialEndsAt: "2099-01-01T00:00:00.000Z", planChosen: null } } });
    tokens.set(trial.tokenHash, trial);
    expect((await call("list_services", {})).status).toBe(200);
  });
});

describe("report_usage", () => {
  const report = { conversationId: "CA0123456789abcdef0123456789abcdef", channel: "call", minutes: 3.5, endedAt: new Date(Date.now() - 60_000).toISOString() };

  it("201 counts the minutes once per conversation; a repeat is 200 replayed with the first figure", async () => {
    const first = await call("report_usage", report);
    expect(first).toMatchObject({ status: 201, body: { usage: { conversationId: report.conversationId, channel: "call", minutes: 3.5, replayed: false } } });
    expect(store.recordAiMinutes).toHaveBeenCalledWith({ garageId: GARAGE_ID, conversationId: report.conversationId, minutes: 3.5, endedAt: new Date(report.endedAt) });
    const again = await call("report_usage", { ...report, minutes: 9 });
    expect(again).toMatchObject({ status: 200, body: { usage: { minutes: 3.5, replayed: true } } });
    expect(calls.map((entry) => [entry.tool, entry.outcome, entry.httpStatus])).toEqual([["report_usage", "OK", 201], ["report_usage", "OK", 200]]);
  });

  it("422 for bad bodies: no minutes, negative or huge minutes, an unknown channel, a garage id, a phone-number id, an old or future end", async () => {
    const bad: unknown[] = [
      { ...report, minutes: 0 },
      { ...report, minutes: -1 },
      { ...report, minutes: 601 },
      { ...report, channel: "sms" },
      { ...report, garageId: OTHER_GARAGE_ID },
      { ...report, conversationId: "+44 7700 900123" },
      { conversationId: report.conversationId, channel: "call", endedAt: report.endedAt },
      { ...report, endedAt: "yesterday" },
    ];
    for (const body of bad) {
      expect(await call("report_usage", body)).toMatchObject({ status: 422, body: { code: "INVALID_REQUEST" } });
      expect(requestValidator("report_usage")(JSON.parse(JSON.stringify(body))), JSON.stringify(body)).toBe(false);
    }
    for (const endedAt of [new Date(Date.now() - 40 * 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()]) {
      expect(await call("report_usage", { ...report, endedAt })).toMatchObject({ status: 422, body: { code: "INVALID_REQUEST", issues: [{ path: "endedAt" }] } });
    }
    expect(store.recordAiMinutes).not.toHaveBeenCalled();
  });

  it("503 when the minutes could not be stored (Workforce retries; the id keeps it counted once)", async () => {
    vi.mocked(store.recordAiMinutes).mockResolvedValueOnce({ status: "failed" });
    expect(await call("report_usage", report)).toMatchObject({ status: 503, body: { code: "UNAVAILABLE" } });
  });

  it("403 FORBIDDEN for a workforce token without the report_usage scope", async () => {
    expect(await call("report_usage", report, { token: NARROW_TOKEN })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
  });
});

describe("log_call_summary (voice desk per-call tokens)", () => {
  const note = { callSid: CALL_SID, summary: "Sam wants a full service on AB12 CDE next Tuesday; booking request made.", outcome: "booked" };

  it("201 stores the note once, registrations masked; a repeat is 200 with stored false", async () => {
    expect(await call("log_call_summary", note, { token: CALL_TOKEN })).toMatchObject({ status: 201, body: { callSid: CALL_SID, outcome: "booked", stored: true } });
    expect(store.recordCallSummary).toHaveBeenCalledWith({ garageId: GARAGE_ID, callSid: CALL_SID, summary: "Sam wants a full service on [reg] next Tuesday; booking request made.", outcome: "booked" });
    expect(await call("log_call_summary", { ...note, outcome: "message" }, { token: CALL_TOKEN })).toMatchObject({ status: 200, body: { stored: false } });
  });

  it("403 for a token not minted for this call, 401 once the call token has expired", async () => {
    expect(await call("log_call_summary", note)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await call("log_call_summary", { ...note, callSid: "CA0123456789abcdef0123456789abcdee" }, { token: CALL_TOKEN })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await call("list_services", {}, { token: EXPIRED_CALL_TOKEN })).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
    expect(store.recordCallSummary).not.toHaveBeenCalled();
  });

  it("422 for an unknown outcome, an empty or long summary, or a non-CallSid", async () => {
    for (const body of [{ ...note, outcome: "sold" }, { ...note, summary: "" }, { ...note, summary: "x".repeat(1001) }, { ...note, callSid: "+447700900123" }]) {
      expect(await call("log_call_summary", body, { token: CALL_TOKEN })).toMatchObject({ status: 422, body: { code: "INVALID_REQUEST" } });
      expect(requestValidator("log_call_summary")(JSON.parse(JSON.stringify(body))), JSON.stringify(body)).toBe(false);
    }
  });
});

describe("audit", () => {
  it("records garage, token, tool, outcome, status and latency for each call; logs carry no phone, registration or token", async () => {
    await call("create_booking", bookingBody);
    await call("get_booking", { reference: "HRM-4821", registration: "AB12 CDE" });
    await call("lookup_vehicle", { registration: "AB12CDE" });
    expect(calls.map((entry) => [entry.tool, entry.outcome, entry.httpStatus])).toEqual([
      ["create_booking", "OK", 201],
      ["get_booking", "OK", 200],
      ["lookup_vehicle", "OK", 200],
    ]);
    for (const entry of calls) {
      expect(entry).toMatchObject({ garageId: GARAGE_ID, tokenId: "tok-A" });
      expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
    }
    const everything = JSON.stringify(calls) + logLines.join("\n");
    for (const secret of [TOKEN, hashAgentToken(TOKEN), "AB12", "07700", "900123", "+447700"]) expect(everything).not.toContain(secret);
    expect(logLines).toHaveLength(3);
    expect(JSON.parse(logLines[0]!)).toMatchObject({ event: "agent_api.call", garage_id: GARAGE_ID, token_id: "tok-A", tool: "create_booking", outcome: "OK", status: 201 });
  });
});
