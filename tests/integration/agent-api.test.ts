import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../../src/lib/agent-api/schemas";
import { expectMatchesSpec } from "../../src/__tests__/support/agent-api-spec";
import { getLocalSupabaseConfig, provisionLocalTestUsers, type LocalTestUsers } from "../helpers/local-supabase";

// Agent tool API (P4.2) against local Supabase: tokens issued through
// issue_agent_token() (hash only), every route end to end, responses checked
// against docs/autofix/agent-api.yaml, audit rows in agent_call_log, and
// create_booking always `requested` / `ai_agent`. Skipped only when no local
// database is configured (see booking-api.test.ts for the env).

const configured = Boolean(process.env.INTEGRATION_SUPABASE_URL);

// The database limiter is covered elsewhere; this file makes many calls with one token.
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn(async () => true) }));

type Routes = Record<AgentTool, (request: Request) => Promise<Response>>;

let users: LocalTestUsers;
let service: SupabaseClient;
let routes: Routes;
let tokenA: string;
let tokenAId: string;
let tokenB: string;
let narrowTokenA: string;
let serviceA: string;
let day: string;

function nextTuesday() {
  const date = new Date(Date.now() + 3 * 86_400_000);
  while (new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(date) !== "Tue") date.setUTCDate(date.getUTCDate() + 1);
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(date);
}

async function insert(table: string, rows: Record<string, unknown>[]) {
  const { data, error } = await service.from(table).insert(rows).select("id");
  if (error) throw new Error(`Could not seed ${table}: ${error.message}`);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

async function seedGarage(garageId: string) {
  await insert("resources", [{ garage_id: garageId, name: "Bay 1", kind: "bay", active: true, sort: 1 }]);
  await insert("opening_hours", [{ garage_id: garageId, weekday: 2, opens: "08:00", closes: "17:00" }]);
  const [id] = await insert("services", [{
    garage_id: garageId, name: "Full service", description: "Agent integration", duration_min: 60, buffer_min: 0, price_pence: 9900, price_mode: "fixed",
    location_mode: "workshop", resource_kind: "bay", online_enabled: true, needs_approval: false, min_notice_h: 2, max_days_ahead: 60, is_mot: false, sort: 1,
  }]);
  return id!;
}

async function call(tool: AgentTool, body: unknown, token: string | null = tokenA) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await routes[tool](new NextRequest(`http://localhost:3000/api/agent/v1/${tool}`, { method: "POST", headers, body: JSON.stringify(body) }));
  const json = (await response.json()) as Record<string, unknown>;
  expectMatchesSpec(tool, response.status, json);
  return { status: response.status, body: json };
}

describe.skipIf(!configured).sequential("agent tool API against local Supabase", () => {
  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.BOOKING_MANAGEMENT_SECRET = "integration-booking-management-secret-0123456789";
    process.env.AGENT_TOKEN_PEPPER = "integration-agent-token-pepper-0123456789";
    users = await provisionLocalTestUsers();
    service = users.service;
    serviceA = await seedGarage(users.garageA.id);
    await seedGarage(users.garageB.id);
    await service.from("garages").update({ settings: { faqs: [{ question: "Do you take cards?", answer: "Yes." }] } }).eq("id", users.garageA.id);
    day = nextTuesday();

    const { issueAgentToken } = await import("../../src/lib/agent-api/store");
    const issuedA = await issueAgentToken({ garageId: users.garageA.id, name: "Workforce voice" }, service);
    tokenA = issuedA.token;
    tokenAId = issuedA.id;
    tokenB = (await issueAgentToken({ garageId: users.garageB.id, name: "Workforce B" }, service)).token;
    narrowTokenA = (await issueAgentToken({ garageId: users.garageA.id, name: "Askbridge", scopes: ["list_services", "garage_profile"] }, service)).token;

    routes = {
      lookup_vehicle: (await import("../../src/app/api/agent/v1/lookup_vehicle/route")).POST,
      list_services: (await import("../../src/app/api/agent/v1/list_services/route")).POST,
      available_slots: (await import("../../src/app/api/agent/v1/available_slots/route")).POST,
      create_booking: (await import("../../src/app/api/agent/v1/create_booking/route")).POST,
      get_booking: (await import("../../src/app/api/agent/v1/get_booking/route")).POST,
      garage_profile: (await import("../../src/app/api/agent/v1/garage_profile/route")).POST,
      report_usage: (await import("../../src/app/api/agent/v1/report_usage/route")).POST,
      log_call_summary: (await import("../../src/app/api/agent/v1/log_call_summary/route")).POST,
    };
  });

  it("stores only an HMAC of each token", async () => {
    const { data } = await service.from("agent_tokens").select("token_hash,scopes,audience").eq("id", tokenAId).single();
    expect(data?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data?.token_hash).not.toContain(tokenA.slice(5, 15));
    // P5.12: every tool, report_usage included, for a workforce token.
    expect(data?.scopes).toHaveLength(7);
    expect(data?.audience).toBe("workforce");
  });

  it("P5.12: report_usage records AI minutes once per conversation in usage_events", async () => {
    const conversationId = `CA${randomUUID().replaceAll("-", "")}`;
    const body = { conversationId, channel: "call", minutes: 2.25, endedAt: new Date(Date.now() - 60_000).toISOString() };
    expect(await call("report_usage", body)).toMatchObject({ status: 201, body: { usage: { conversationId, minutes: 2.25, replayed: false } } });
    expect(await call("report_usage", { ...body, minutes: 7 })).toMatchObject({ status: 200, body: { usage: { minutes: 2.25, replayed: true } } });
    const { data } = await service.from("usage_events").select("metric,quantity").eq("garage_id", users.garageA.id).eq("source_key", `ai:${conversationId}`);
    expect(data).toEqual([{ metric: "ai_minutes", quantity: 2.25 }]);
    expect(await call("report_usage", body, narrowTokenA)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
  });

  it("lists the token's garage services and free slots", async () => {
    const services = await call("list_services", {});
    expect(services.status).toBe(200);
    expect((services.body.services as Array<{ id: string }>).map((entry) => entry.id)).toEqual([serviceA]);
    const slots = await call("available_slots", { serviceId: serviceA, from: day, to: day });
    expect(slots.status).toBe(200);
    expect((slots.body.slots as unknown[]).length).toBeGreaterThan(10);
  });

  it("garage B's token cannot reach garage A's service", async () => {
    expect(await call("available_slots", { serviceId: serviceA, from: day, to: day }, tokenB)).toMatchObject({ status: 422, body: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("creates a requested ai_agent booking, audits it, and reads it back by reference + registration", async () => {
    const slots = await call("available_slots", { serviceId: serviceA, from: day, to: day });
    const startsAt = (slots.body.slots as Array<{ startsAt: string }>)[4]!.startsAt;
    const registration = `ag${randomUUID().slice(0, 5)}`.toUpperCase();
    const body = {
      serviceId: serviceA,
      startsAt,
      customer: { name: "Agent Caller", phone: "07700 900456" },
      vehicle: { registration, make: "Test" },
      idempotencyKey: randomUUID(),
    };
    const created = await call("create_booking", body);
    expect(created).toMatchObject({ status: 201, body: { booking: { status: "requested", startsAt }, replayed: false } });
    const reference = (created.body.booking as { reference: string }).reference;

    const { data: row } = await service.from("bookings").select("id,status,source,customers(reminder_consent)").eq("garage_id", users.garageA.id).eq("reference", reference).single();
    expect(row).toMatchObject({ status: "requested", source: "ai_agent", customers: { reminder_consent: false } });

    expect(await call("create_booking", body)).toMatchObject({ status: 200, body: { replayed: true, booking: { reference } } });

    const { data: log } = await service.from("agent_call_log").select("tool,outcome,http_status,latency_ms,token_id,booking_id").eq("garage_id", users.garageA.id).eq("tool", "create_booking").order("created_at");
    expect(log?.[0]).toMatchObject({ outcome: "OK", http_status: 201, token_id: tokenAId, booking_id: row!.id });

    const found = await call("get_booking", { reference, registration: registration.toLowerCase() });
    expect(found).toMatchObject({ status: 200, body: { booking: { reference, status: "requested", customerFirstName: "Agent" } } });
    expect(await call("get_booking", { reference, registration }, tokenB)).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(await call("get_booking", { reference, registration: "ZZ99ZZZ" })).toMatchObject({ status: 404 });
  });

  it("returns the garage profile with hours and FAQs", async () => {
    const result = await call("garage_profile", {});
    expect(result).toMatchObject({
      status: 200,
      body: { garage: { name: users.garageA.name }, openingHours: [{ weekday: 2, day: "Tuesday", opens: "08:00", closes: "17:00" }], faqs: [{ question: "Do you take cards?" }] },
    });
  });

  it("enforces scopes, refreshes last_used_at, and rejects a revoked token", async () => {
    expect(await call("create_booking", {}, narrowTokenA)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    const { data: used } = await service.from("agent_tokens").select("last_used_at").eq("id", tokenAId).single();
    expect(used?.last_used_at).not.toBeNull();

    const revoked = await users.admin.rpc("revoke_agent_token", { p_token_id: tokenAId });
    expect(revoked.error).toBeNull();
    expect(revoked.data).toBe(true);
    expect(await call("list_services", {})).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });

    const listed = await users.admin.rpc("list_agent_tokens");
    expect(listed.error).toBeNull();
    expect((listed.data as Array<Record<string, unknown>>).every((entry) => !("token_hash" in entry))).toBe(true);
    expect((listed.data as Array<{ name: string }>).map((entry) => entry.name).sort()).toEqual(["Askbridge", "Workforce voice"]);
    expect((await users.otherGarageAdmin.rpc("list_agent_tokens")).data).toEqual([expect.objectContaining({ name: "Workforce B", audience: "workforce" })]);
  });

  it("P5.12: on Essentials a workforce token gets PLAN_REQUIRED (audited) and an askbridge token keeps reading", async () => {
    const { issueAgentToken } = await import("../../src/lib/agent-api/store");
    const { PlanRequiredError } = await import("../../src/lib/plans/entitlements");
    const askbridgeB = await issueAgentToken({ garageId: users.garageB.id, name: "Askbridge B", audience: "askbridge" }, service);
    expect(askbridgeB.scopes.sort()).toEqual(["available_slots", "garage_profile", "list_services"]);
    const { error } = await service.from("garages").update({ plan: "essentials", plan_chosen: "essentials", trial_ends_at: null }).eq("id", users.garageB.id);
    expect(error).toBeNull();

    expect(await call("list_services", {}, tokenB)).toMatchObject({ status: 403, body: { code: "PLAN_REQUIRED", feature: "ai_front_desk", plan: "pro" } });
    const { data: log } = await service.from("agent_call_log").select("outcome,http_status").eq("garage_id", users.garageB.id).eq("outcome", "PLAN_REQUIRED");
    expect(log).toEqual([{ outcome: "PLAN_REQUIRED", http_status: 403 }]);

    expect((await call("list_services", {}, askbridgeB.token)).status).toBe(200);
    expect(await call("create_booking", {}, askbridgeB.token)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    await expect(issueAgentToken({ garageId: users.garageB.id, name: "Workforce again" }, service)).rejects.toBeInstanceOf(PlanRequiredError);
  });

  it("voice desk: one expiring token per recent call while the front desk is on; it books, reports and logs the summary", async () => {
    const { issueVoiceCallToken } = await import("../../src/lib/agent-api/store");
    const garageId = users.garageA.id;
    const callSid = `CA${randomUUID().replaceAll("-", "")}`;
    await insert("calls", [{ garage_id: garageId, provider_call_sid: callSid, from_number: "+447700900555", to_number: "+447700100200", status: "in-progress", missed: true }]);

    expect(await issueVoiceCallToken({ garageId, callSid }, service)).toEqual({ ok: false, code: "FRONT_DESK_OFF" });
    expect((await service.rpc("ai_front_desk_voice_ready", { p_garage_id: garageId, p_allowance: 200 })).data).toBe(false);
    const { error: switchError } = await service.from("ai_front_desk_settings").upsert({ garage_id: garageId, enabled: true, enabled_at: new Date().toISOString() });
    expect(switchError).toBeNull();
    expect((await service.rpc("ai_front_desk_voice_ready", { p_garage_id: garageId, p_allowance: 200 })).data).toBe(true);
    expect((await service.rpc("ai_front_desk_voice_ready", { p_garage_id: garageId, p_allowance: null })).data).toBe(true);
    expect(await issueVoiceCallToken({ garageId, callSid: `CA${randomUUID().replaceAll("-", "")}` }, service)).toEqual({ ok: false, code: "CALL_NOT_FOUND" });
    expect(await issueVoiceCallToken({ garageId: users.garageB.id, callSid }, service)).toEqual({ ok: false, code: "CALL_NOT_FOUND" });

    const issued = await issueVoiceCallToken({ garageId, callSid }, service);
    if (!issued.ok) throw new Error(`no call token: ${issued.code}`);
    expect(await issueVoiceCallToken({ garageId, callSid }, service)).toEqual({ ok: false, code: "ALREADY_ISSUED" });
    const { data: row } = await service.from("agent_tokens").select("call_sid,expires_at,audience,scopes").eq("call_sid", callSid).single();
    expect(row).toMatchObject({ call_sid: callSid, audience: "workforce" });
    expect(row?.scopes).toContain("log_call_summary");
    expect(Date.parse(String(row?.expires_at))).toBeGreaterThan(Date.now());
    // Staff never see per-call tokens.
    expect(((await users.admin.rpc("list_agent_tokens")).data as Array<{ name: string }>).map((entry) => entry.name)).not.toContain("AI front desk call");

    expect((await call("list_services", {}, issued.token)).status).toBe(200);
    const note = { callSid, summary: "Asked about a service for EF34 GHI; wants a call back.", outcome: "callback" };
    expect(await call("log_call_summary", note, issued.token)).toMatchObject({ status: 201, body: { stored: true } });
    expect(await call("log_call_summary", note, issued.token)).toMatchObject({ status: 200, body: { stored: false } });
    expect(await call("log_call_summary", note, tokenB)).toMatchObject({ status: 403 });
    const { data: logged } = await service.from("calls").select("ai_summary,ai_outcome,ai_handled_at").eq("provider_call_sid", callSid).single();
    expect(logged).toMatchObject({ ai_summary: "Asked about a service for [reg]; wants a call back.", ai_outcome: "callback" });
    expect(logged?.ai_handled_at).not.toBeNull();

    const usage = { conversationId: callSid, channel: "call", minutes: 3, endedAt: new Date().toISOString() };
    expect(await call("report_usage", usage, issued.token)).toMatchObject({ status: 201 });
    expect((await service.rpc("ai_front_desk_voice_ready", { p_garage_id: garageId, p_allowance: 1 })).data).toBe(false);

    await service.from("agent_tokens").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("call_sid", callSid);
    expect(await call("list_services", {}, issued.token)).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
  });
});
