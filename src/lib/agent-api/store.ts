import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { BookingEngineError } from "@/lib/booking-engine/errors";
import { findBookingForManage, type ManagedBooking } from "@/lib/booking-engine/manage";
import { agentTools, isAgentTool, type AgentErrorCode, type AgentTool } from "@/lib/agent-api/schemas";
import { generateAgentToken, hashAgentToken } from "@/lib/agent-api/tokens";
import { createAdminClient } from "@/lib/supabase/server";
import type { GarageAddress } from "@/lib/tenancy/garage";

// Everything the agent API reads or writes outside the booking engine, behind
// one interface so the routes can be tested without a database. The Supabase
// implementation uses the service role and names the garage in every query;
// the garage always comes from the verified token.

export type AgentTokenRecord = {
  id: string;
  garageId: string;
  tokenHash: string;
  scopes: AgentTool[];
  revokedAt: string | null;
  garage: { status: string; motEnabled: boolean; timezone: string };
};

export type AgentCallEntry = {
  garageId: string;
  tokenId: string;
  tool: AgentTool;
  /** `OK` or the error code returned. */
  outcome: "OK" | AgentErrorCode;
  httpStatus: number;
  latencyMs: number;
  bookingId?: string | null;
};

export type AgentGarageRecord = {
  name: string;
  slug: string;
  customDomain: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: GarageAddress;
  timezone: string;
  motEnabled: boolean;
  approveOnline: boolean;
  serviceArea: string[];
  cancellationCutoffH: number;
  openingHours: Array<{ weekday: number; opens: string; closes: string }>;
  closures: Array<{ startsOn: string; endsOn: string; reason: string | null }>;
  faqs: Array<{ question: string; answer: string }>;
};

export interface AgentApiStore {
  findToken(tokenHash: string): Promise<AgentTokenRecord | null>;
  /** Writes the audit row and refreshes `last_used_at`. Never throws. */
  recordCall(entry: AgentCallEntry): Promise<void>;
  garageProfile(garageId: string, today: string): Promise<AgentGarageRecord | null>;
  findBooking(garageId: string, reference: string, registration: string): Promise<ManagedBooking | null>;
}

type Related<T> = T | T[] | null;
const relation = <T>(value: Related<T>): T | null => (Array.isArray(value) ? value[0] ?? null : value);

type TokenRow = {
  id: string;
  garage_id: string;
  token_hash: string;
  scopes: string[] | null;
  revoked_at: string | null;
  garages: Related<{ status: string; mot_enabled: boolean | null; timezone: string | null }>;
};

/** `last_used_at` is refreshed at most once a minute per token. */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_FAQS = 50;

function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** `garages.settings.faqs`: `[{question, answer}]`, entries without both are skipped. */
export function faqsFromSettings(settings: unknown): Array<{ question: string; answer: string }> {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).faqs : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const question = text((entry as Record<string, unknown>).question, 300);
    const answer = text((entry as Record<string, unknown>).answer, 2000);
    return question && answer ? [{ question, answer }] : [];
  }).slice(0, MAX_FAQS);
}

function activeCustomDomain(domains: Array<{ hostname: string; kind: string | null; status: string | null; deleted_at: string | null; created_at: string | null }> | null) {
  const active = (domains ?? [])
    .filter((domain) => domain.kind === "custom" && domain.status === "active" && !domain.deleted_at)
    .sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")));
  return active[0]?.hostname ?? null;
}

const hhmm = (value: string) => value.slice(0, 5);

export function createSupabaseAgentApiStore(getClient: () => SupabaseClient | null = createAdminClient, now: () => Date = () => new Date()): AgentApiStore {
  function client() {
    const value = getClient();
    if (!value) throw new BookingEngineError("UNAVAILABLE");
    return value;
  }

  return {
    async findToken(tokenHash) {
      const { data, error } = await client()
        .from("agent_tokens")
        .select("id,garage_id,token_hash,scopes,revoked_at,garages(status,mot_enabled,timezone)")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw new BookingEngineError("UNAVAILABLE");
      if (!data) return null;
      const row = data as unknown as TokenRow;
      const garage = relation(row.garages);
      if (!garage) return null;
      return {
        id: row.id,
        garageId: row.garage_id,
        tokenHash: row.token_hash,
        scopes: (row.scopes ?? []).filter(isAgentTool),
        revokedAt: row.revoked_at,
        garage: { status: garage.status, motEnabled: Boolean(garage.mot_enabled), timezone: garage.timezone || "Europe/London" },
      };
    },

    async recordCall(entry) {
      try {
        const db = client();
        const at = now();
        await Promise.all([
          db.from("agent_call_log").insert({
            garage_id: entry.garageId,
            token_id: entry.tokenId,
            tool: entry.tool,
            outcome: entry.outcome,
            http_status: entry.httpStatus,
            latency_ms: Math.max(0, Math.round(entry.latencyMs)),
            booking_id: entry.bookingId ?? null,
          }),
          db
            .from("agent_tokens")
            .update({ last_used_at: at.toISOString() })
            .eq("garage_id", entry.garageId)
            .eq("id", entry.tokenId)
            .or(`last_used_at.is.null,last_used_at.lt.${new Date(at.getTime() - TOUCH_INTERVAL_MS).toISOString()}`),
        ]);
      } catch {
        // Auditing never fails the call; the structured log line still records it.
      }
    },

    async garageProfile(garageId, today) {
      const db = client();
      const [garage, hours, closures] = await Promise.all([
        db
          .from("garages")
          .select("name,slug,phone,whatsapp,email,address,timezone,mot_enabled,approve_online,service_area,cancellation_cutoff_h,settings,garage_domains(hostname,kind,status,deleted_at,created_at)")
          .eq("id", garageId)
          .maybeSingle(),
        db.from("opening_hours").select("weekday,opens,closes").eq("garage_id", garageId).order("weekday").order("opens"),
        db.from("closures").select("starts_on,ends_on,reason").eq("garage_id", garageId).gte("ends_on", today).order("starts_on").limit(20),
      ]);
      if (garage.error || hours.error || closures.error) throw new BookingEngineError("UNAVAILABLE");
      if (!garage.data) return null;
      const row = garage.data as Record<string, unknown>;
      return {
        name: String(row.name),
        slug: String(row.slug),
        customDomain: activeCustomDomain(row.garage_domains as never),
        phone: (row.phone as string | null) ?? null,
        whatsapp: (row.whatsapp as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        address: (row.address as GarageAddress | null) ?? {},
        timezone: (row.timezone as string | null) || "Europe/London",
        motEnabled: Boolean(row.mot_enabled),
        approveOnline: Boolean(row.approve_online),
        serviceArea: (row.service_area as string[] | null) ?? [],
        cancellationCutoffH: (row.cancellation_cutoff_h as number | null) ?? 24,
        openingHours: ((hours.data ?? []) as Array<{ weekday: number; opens: string; closes: string }>).map((entry) => ({
          weekday: entry.weekday,
          opens: hhmm(entry.opens),
          closes: hhmm(entry.closes),
        })),
        closures: ((closures.data ?? []) as Array<{ starts_on: string; ends_on: string; reason: string | null }>).map((entry) => ({
          startsOn: entry.starts_on,
          endsOn: entry.ends_on,
          reason: entry.reason,
        })),
        faqs: faqsFromSettings(row.settings),
      };
    },

    findBooking(garageId, reference, registration) {
      return findBookingForManage({ garageId, reference, registration }, now());
    },
  };
}

let store: AgentApiStore | null = null;

export function getAgentApiStore(): AgentApiStore {
  store ??= createSupabaseAgentApiStore();
  return store;
}

/** Tests inject an in-memory store; `null` restores the Supabase one. */
export function setAgentApiStoreForTests(next: AgentApiStore | null) {
  store = next;
}

export type IssuedAgentToken = { id: string; garageId: string; name: string; scopes: AgentTool[]; createdAt: string; token: string };

/**
 * Issues a token for one garage (service role). The raw token is in the result
 * and nowhere else: hand it to Workforce/Askbridge and do not store it.
 */
export async function issueAgentToken(
  input: { garageId: string; name: string; scopes?: readonly AgentTool[] },
  client: SupabaseClient | null = createAdminClient(),
): Promise<IssuedAgentToken> {
  if (!client) throw new BookingEngineError("UNAVAILABLE");
  const token = generateAgentToken();
  const { data, error } = await client.rpc("issue_agent_token", {
    p_garage_id: input.garageId,
    p_name: input.name,
    p_scopes: input.scopes ? [...input.scopes] : [...agentTools],
    p_token_hash: hashAgentToken(token),
  });
  if (error || !data) throw new Error(`issue_agent_token failed: ${error?.code ?? "no result"}`);
  const row = data as { id: string; garage_id: string; name: string; scopes: string[]; created_at: string };
  return { id: row.id, garageId: row.garage_id, name: row.name, scopes: row.scopes.filter(isAgentTool), createdAt: row.created_at, token };
}
