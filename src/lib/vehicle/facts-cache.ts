import "server-only";

// 24-hour vehicle facts cache (`vehicle_facts`, platform table, service role only).
//
// Key: reg_hash = hex HMAC-SHA-256 of the normalised registration, keyed with
// VEHICLE_FACTS_PEPPER, so the table never holds a plate. Value: vehicle facts
// only (make, model, MOT and tax dates, MOT history). No registration, customer,
// garage or booking data: facts pass through `vehicleFactsSchema`, which keeps
// only whitelisted keys.
//
// Freshness is decided by the caller from `fetchedAt` (see `isFresh`); stale
// rows are overwritten by the next upsert. The Supabase cache fails soft: any
// error, including the table not existing yet (it arrives with the data lane's
// P3.6 migration), logs a warning with the error code only and behaves as a miss.

import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { VehicleDetails } from "@/types/domain";
import { MOT_DEFECT_TYPES, type MotHistory } from "./dvsa";
import type { VehicleSourceName } from "./provider";
import { normalizeRegistration } from "./registration-format";

export const VEHICLE_FACTS_TABLE = "vehicle_facts";
export const VEHICLE_FACTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Peppers shorter than this are treated as not configured. */
export const VEHICLE_FACTS_PEPPER_MIN_LENGTH = 32;

export type VehicleLogger = { warn(message: string, details?: Record<string, unknown>): void };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const label = z.string().max(120);

const vehicleSchema = z.object({
  make: label.optional(),
  model: label.optional(),
  derivative: label.optional(),
  year: z.number().int().optional(),
  colour: label.optional(),
  fuelType: label.optional(),
  transmission: label.optional(),
  engineCapacityCc: z.number().int().optional(),
  bodyType: label.optional(),
  motStatus: z.string().max(60).optional(),
  motExpiry: isoDate.optional(),
  taxStatus: z.string().max(60).optional(),
  taxDueDate: isoDate.optional(),
});

const motTestSchema = z.object({
  completedDate: z.string().max(40),
  result: z.enum(["passed", "failed"]),
  expiryDate: isoDate.optional(),
  odometer: z.object({ value: z.number().int().nonnegative(), unit: z.enum(["mi", "km"]) }).optional(),
  defects: z.array(z.object({
    type: z.enum([...MOT_DEFECT_TYPES, "unknown"]),
    text: z.string().max(500),
    dangerous: z.boolean().optional(),
  })).max(200),
});

const motSchema = z.object({
  motExpiry: isoDate.optional(),
  motTestDueDate: isoDate.optional(),
  lastMotTestDate: isoDate.optional(),
  lastMileage: z.number().int().nonnegative().optional(),
  mileageUnit: z.enum(["mi", "km"]).optional(),
  motTests: z.array(motTestSchema).max(300),
});

/** The shape stored in `vehicle_facts.facts`. Unknown keys are stripped. */
export const vehicleFactsSchema = z.object({
  version: z.literal(1),
  vehicle: vehicleSchema,
  mot: motSchema.optional(),
  sources: z.array(z.enum(["dvla", "dvsa", "vdg"])),
});

export type VehicleFacts = {
  version: 1;
  vehicle: Omit<VehicleDetails, "registration">;
  mot?: MotHistory;
  sources: VehicleSourceName[];
};

export type CachedVehicleFacts = { facts: VehicleFacts; fetchedAt: Date };

export interface VehicleFactsCache {
  /** The stored facts and when they were fetched, or null. Never throws in the shipped implementations. */
  get(regHash: string): Promise<CachedVehicleFacts | null>;
  set(regHash: string, facts: VehicleFacts, fetchedAt?: Date): Promise<void>;
}

const REG_HASH = /^[0-9a-f]{64}$/;

/** Hex HMAC-SHA-256 of the normalised registration. Throws without a registration or pepper. */
export function hashRegistration(registration: string, pepper: string): string {
  const normalized = normalizeRegistration(registration);
  if (!normalized) throw new Error("A registration is required to build the vehicle facts key.");
  if (!pepper) throw new Error("Vehicle facts cache configuration required: VEHICLE_FACTS_PEPPER is not set.");
  return createHmac("sha256", pepper).update(normalized).digest("hex");
}

export function isRegHash(value: string) {
  return REG_HASH.test(value);
}

export function isFresh(fetchedAt: Date, now: Date, maxAgeMs = VEHICLE_FACTS_MAX_AGE_MS) {
  const age = now.getTime() - fetchedAt.getTime();
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

/** Whitelist and validate facts. Returns null when they do not match the stored shape. */
export function toStoredFacts(facts: unknown): VehicleFacts | null {
  const parsed = vehicleFactsSchema.safeParse(facts);
  return parsed.success ? (parsed.data as VehicleFacts) : null;
}

/** Per-process cache for development, tests and deployments without Supabase. */
export function createMemoryVehicleFactsCache(options: { maxEntries?: number } = {}): VehicleFactsCache & { size(): number; clear(): void } {
  const maxEntries = options.maxEntries ?? 1000;
  const entries = new Map<string, { facts: VehicleFacts; fetchedAt: number }>();

  return {
    async get(regHash) {
      if (!isRegHash(regHash)) return null;
      const entry = entries.get(regHash);
      return entry ? { facts: structuredClone(entry.facts), fetchedAt: new Date(entry.fetchedAt) } : null;
    },
    async set(regHash, facts, fetchedAt = new Date()) {
      const stored = toStoredFacts(facts);
      if (!isRegHash(regHash) || !stored) return;
      entries.delete(regHash);
      entries.set(regHash, { facts: stored, fetchedAt: fetchedAt.getTime() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

/** PostgREST "table not in schema cache" and Postgres undefined_table. */
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);
const MISSING_TABLE_RETRY_MS = 5 * 60 * 1000;

export type SupabaseVehicleFactsCacheOptions = {
  /** A service-role client, or a factory returning one (null when Supabase is not configured). */
  client: SupabaseClient | null | (() => SupabaseClient | null);
  logger?: VehicleLogger;
  now?: () => number;
};

function errorCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9]{1,10}$/.test(code) ? code : "unknown";
}

export function createSupabaseVehicleFactsCache(options: SupabaseVehicleFactsCacheOptions): VehicleFactsCache {
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  let client: SupabaseClient | null | undefined;
  let skipUntil = 0;
  const warned = new Set<string>();

  function warnOnce(key: string, message: string, details: Record<string, unknown> = {}) {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message, details);
  }

  function resolveClient() {
    if (client === undefined) client = typeof options.client === "function" ? options.client() : options.client;
    if (!client) warnOnce("no-client", "[vehicle-facts] Supabase service role is not configured; continuing without the shared cache.");
    return client;
  }

  function onError(operation: "read" | "write", error: unknown) {
    const code = errorCode(error);
    if (MISSING_TABLE_CODES.has(code)) {
      skipUntil = now() + MISSING_TABLE_RETRY_MS;
      warnOnce(`missing:${code}`, "[vehicle-facts] vehicle_facts table is missing; treating lookups as cache misses.", { code });
      return;
    }
    warnOnce(`${operation}:${code}`, `[vehicle-facts] cache ${operation} failed; treating as a miss.`, { code });
  }

  return {
    async get(regHash) {
      if (!isRegHash(regHash) || now() < skipUntil) return null;
      const db = resolveClient();
      if (!db) return null;
      try {
        const { data, error } = await db
          .from(VEHICLE_FACTS_TABLE)
          .select("facts, fetched_at")
          .eq("reg_hash", regHash)
          .maybeSingle();
        if (error) {
          onError("read", error);
          return null;
        }
        if (!data) return null;
        const row = data as { facts?: unknown; fetched_at?: unknown };
        const facts = toStoredFacts(row.facts);
        const fetchedAt = typeof row.fetched_at === "string" ? new Date(row.fetched_at) : null;
        if (!facts || !fetchedAt || Number.isNaN(fetchedAt.getTime())) {
          warnOnce("invalid-row", "[vehicle-facts] ignoring a cached row with an unexpected shape.");
          return null;
        }
        return { facts, fetchedAt };
      } catch (error) {
        onError("read", error);
        return null;
      }
    },

    async set(regHash, facts, fetchedAt = new Date(now())) {
      const stored = toStoredFacts(facts);
      if (!isRegHash(regHash) || !stored || now() < skipUntil) return;
      const db = resolveClient();
      if (!db) return;
      try {
        const { error } = await db
          .from(VEHICLE_FACTS_TABLE)
          .upsert({ reg_hash: regHash, facts: stored, fetched_at: fetchedAt.toISOString() }, { onConflict: "reg_hash" });
        if (error) onError("write", error);
      } catch (error) {
        onError("write", error);
      }
    },
  };
}
