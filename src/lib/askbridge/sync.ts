import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { agentGarageProfile, agentService } from "@/lib/agent-api/handler";
import type { AgentGarageProfile, AgentService } from "@/lib/agent-api/schemas";
import { getAgentApiStore, type AgentGarageRecord } from "@/lib/agent-api/store";
import { getBookingEngine } from "@/lib/booking-engine";
import type { OnlineService } from "@/lib/booking-engine/types";
import { createAdminClient } from "@/lib/supabase/server";
import { askbridgeFromSettings } from "./config";

/**
 * Askbridge knowledge sync (P4.6): push a garage's profile and services to Askbridge whenever they
 * change. Contract: `docs/autofix/askbridge.md`.
 *
 * Triggers in `20261028000600_domains_askbridge.sql` enqueue `askbridge.sync` (payload `{garageId}`,
 * one job per garage per minute) when the profile, services, opening hours, closures, FAQs, the
 * widget setting or the custom domain change. The job runner calls `runAskbridgeSync(payload)`:
 * it resolves on success or a deliberate skip, and throws `AskbridgeSyncError` (`retryable`) on
 * failure so the runner can `fail_job(id, message, retryable)`.
 */

export const ASKBRIDGE_SYNC_JOB = "askbridge.sync";
export const ASKBRIDGE_SCHEMA = "autofix.askbridge.knowledge.v1";
export const ASKBRIDGE_SIGNATURE_HEADER = "Autofix-Signature";
const TIMEOUT_MS = 10_000;

type Env = Readonly<Record<string, string | undefined>>;

export type AskbridgeKnowledge = {
  schema: typeof ASKBRIDGE_SCHEMA;
  event: "knowledge.sync";
  garageId: string;
  widgetId: string;
  /** SHA-256 of the profile and services: unchanged knowledge has the same hash (and idempotency key). */
  contentHash: string;
  generatedAt: string;
  /** Exactly the agent API's `garage_profile` response. */
  profile: AgentGarageProfile;
  /** Exactly the agent API's `list_services` items (bookable online). */
  services: AgentService[];
};

export type AskbridgeReadiness = { status: "operational" | "mock" | "configuration_required"; missing: string[] };

export function getAskbridgeReadiness(env: Env = process.env): AskbridgeReadiness {
  const missing = ["ASKBRIDGE_SYNC_URL", "ASKBRIDGE_WEBHOOK_SECRET"].filter((name) => !env[name]?.trim());
  const url = env.ASKBRIDGE_SYNC_URL?.trim();
  if (url) {
    try {
      if (new URL(url).protocol !== "https:" && env.NODE_ENV === "production") missing.push("ASKBRIDGE_SYNC_URL_HTTPS");
    } catch {
      missing.push("ASKBRIDGE_SYNC_URL_VALID");
    }
  }
  if (missing.length === 0) return { status: "operational", missing };
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") return { status: "configuration_required", missing };
  return { status: "mock", missing: [] };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function buildAskbridgeKnowledge(input: { garageId: string; widgetId: string; garage: AgentGarageRecord; services: OnlineService[]; now: Date }): AskbridgeKnowledge {
  const profile = agentGarageProfile(input.garage);
  const services = input.services.map(agentService);
  const contentHash = createHash("sha256").update(stableJson({ widgetId: input.widgetId, profile, services })).digest("hex");
  return { schema: ASKBRIDGE_SCHEMA, event: "knowledge.sync", garageId: input.garageId, widgetId: input.widgetId, contentHash, generatedAt: input.now.toISOString(), profile, services };
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA-256(secret, "<t>.<raw body>")>`. */
export function signAskbridgeBody(body: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

/** Receiver-side check (documented for Askbridge; also used by tests and the local stub). */
export function verifyAskbridgeSignature(body: string, header: string | null, secret: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries((header ?? "").split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signAskbridgeBody(body, secret, timestamp).split("v1=")[1] ?? "", "hex");
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function askbridgeIdempotencyKey(knowledge: Pick<AskbridgeKnowledge, "garageId" | "contentHash">) {
  return `askbridge-sync:${knowledge.garageId}:${knowledge.contentHash.slice(0, 32)}`;
}

export class AskbridgeSyncError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "AskbridgeSyncError";
  }
}

export type AskbridgeSyncPayload = { garageId: string };

export type AskbridgeSyncResult =
  | { status: "sent"; httpStatus: number; contentHash: string; idempotencyKey: string }
  | { status: "mocked"; contentHash: string; idempotencyKey: string }
  | { status: "skipped"; reason: "garage_not_found" | "garage_inactive" | "askbridge_disabled" };

export type AskbridgeGarageState = { status: string; timezone: string; settings: unknown };

export type AskbridgeSyncDeps = {
  loadGarage?: (garageId: string) => Promise<AskbridgeGarageState | null>;
  loadProfile?: (garageId: string, today: string) => Promise<AgentGarageRecord | null>;
  listServices?: (garageId: string) => Promise<OnlineService[]>;
  fetch?: typeof fetch;
  env?: Env;
  now?: Date;
};

/** What the mock mode "sent" (dev and tests; never leaves the process). */
export type AskbridgeOutboxEntry = { url: string | null; headers: Record<string, string>; body: string };
const OUTBOX_KEY = Symbol.for("autofix.askbridge.outbox");
export function askbridgeOutbox(): AskbridgeOutboxEntry[] {
  const store = globalThis as Record<symbol, unknown>;
  return (store[OUTBOX_KEY] ??= []) as AskbridgeOutboxEntry[];
}

async function defaultLoadGarage(garageId: string): Promise<AskbridgeGarageState | null> {
  const client = createAdminClient();
  if (!client) throw new AskbridgeSyncError("Supabase is not configured", true);
  const { data, error } = await client.from("garages").select("status, timezone, settings").eq("id", garageId).maybeSingle();
  if (error) throw new AskbridgeSyncError(`garage read failed: ${error.code ?? "unknown"}`, true);
  return data ? { status: String(data.status), timezone: String(data.timezone || "Europe/London"), settings: data.settings } : null;
}

function localDate(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(at);
}

const SERVED = new Set(["active", "onboarding"]);

/** The `askbridge.sync` job. Sends no customer data: only the garage's profile and services. */
export async function runAskbridgeSync(payload: AskbridgeSyncPayload, deps: AskbridgeSyncDeps = {}): Promise<AskbridgeSyncResult> {
  const garageId = typeof payload?.garageId === "string" ? payload.garageId : "";
  if (!/^[0-9a-f-]{36}$/i.test(garageId)) throw new AskbridgeSyncError("payload.garageId must be a uuid", false);
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();

  const garage = await (deps.loadGarage ?? defaultLoadGarage)(garageId);
  if (!garage) return { status: "skipped", reason: "garage_not_found" };
  if (!SERVED.has(garage.status)) return { status: "skipped", reason: "garage_inactive" };
  const askbridge = askbridgeFromSettings(garage.settings);
  if (!askbridge.enabled || !askbridge.widgetId) return { status: "skipped", reason: "askbridge_disabled" };

  const readiness = getAskbridgeReadiness(env);
  if (readiness.status === "configuration_required") throw new AskbridgeSyncError(`Askbridge sync is not configured (${readiness.missing.join(", ")})`, true);

  let profile: AgentGarageRecord | null;
  let services: OnlineService[];
  try {
    [profile, services] = await Promise.all([
      (deps.loadProfile ?? ((id, today) => getAgentApiStore().garageProfile(id, today)))(garageId, localDate(now, garage.timezone)),
      (deps.listServices ?? ((id) => getBookingEngine().listOnlineServices(id)))(garageId),
    ]);
  } catch (error) {
    if (error instanceof AskbridgeSyncError) throw error;
    throw new AskbridgeSyncError("garage knowledge could not be read", true);
  }
  if (!profile) return { status: "skipped", reason: "garage_not_found" };

  const knowledge = buildAskbridgeKnowledge({ garageId, widgetId: askbridge.widgetId, garage: profile, services, now });
  const body = JSON.stringify(knowledge);
  const idempotencyKey = askbridgeIdempotencyKey(knowledge);
  const secret = env.ASKBRIDGE_WEBHOOK_SECRET?.trim() ?? "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "user-agent": "Autofix-Askbridge-Sync/1",
    [ASKBRIDGE_SIGNATURE_HEADER.toLowerCase()]: signAskbridgeBody(body, secret || "mock-secret", Math.floor(now.getTime() / 1000)),
  };

  if (readiness.status === "mock") {
    const outbox = askbridgeOutbox();
    outbox.push({ url: env.ASKBRIDGE_SYNC_URL?.trim() || null, headers, body });
    if (outbox.length > 100) outbox.splice(0, outbox.length - 100);
    return { status: "mocked", contentHash: knowledge.contentHash, idempotencyKey };
  }

  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(env.ASKBRIDGE_SYNC_URL!.trim(), { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch {
    throw new AskbridgeSyncError("Askbridge could not be reached", true);
  }
  // 409: Askbridge already has this idempotency key, i.e. this exact knowledge.
  if (response.ok || response.status === 409) return { status: "sent", httpStatus: response.status, contentHash: knowledge.contentHash, idempotencyKey };
  const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  throw new AskbridgeSyncError(`Askbridge answered ${response.status}`, retryable, response.status);
}
