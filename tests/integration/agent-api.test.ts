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
    };
  });

  it("stores only an HMAC of each token", async () => {
    const { data } = await service.from("agent_tokens").select("token_hash,scopes").eq("id", tokenAId).single();
    expect(data?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data?.token_hash).not.toContain(tokenA.slice(5, 15));
    expect(data?.scopes).toHaveLength(6);
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
    expect((await users.otherGarageAdmin.rpc("list_agent_tokens")).data).toEqual([expect.objectContaining({ name: "Workforce B" })]);
  });
});
