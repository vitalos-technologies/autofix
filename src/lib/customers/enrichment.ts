import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { getConfiguredEnrichmentLookup, type EnrichmentFacts, type EnrichmentLookup } from "@/lib/vehicle/configured-provider";
import { VehicleLookupError } from "@/lib/vehicle/provider";

// Background enrichment of imported vehicles (P3.11).
//
// Vehicles an import created or listed are queued with
// `vehicles.enrichment_status = 'pending'`. enrichImportedVehicles() takes the
// oldest pending vehicles of one garage, looks each one up with the free
// configured source (DVSA MOT History: MOT expiry and mileage; see
// getConfiguredEnrichmentLookup) in small batches, and writes mot_expiry,
// mot_checked_at, last_mileage and any missing make/model/colour/fuel/year.
// Facts already on the vehicle are kept; mileage only goes up.
//
// Idempotent: only `pending` rows are read, and each update is conditional on
// the row still being pending, so overlapping runs never double-write.
// A rate limit stops the run with the rest left pending; a failing source is
// retried on later runs and the vehicle is marked `failed` after
// MAX_ATTEMPTS. Registrations are never logged.
//
// Callers:
//   - the import action, through after(), for a bounded first batch;
//   - the job queue (P3.6/P3.7) should register it as job `customers.enrich`
//     with payload { garageId, importId? } and re-enqueue while `remaining`
//     is true (after `retryAfterMs` when it stopped on a rate limit).

export const ENRICHMENT_MAX_ATTEMPTS = 3;

export type EnrichImportedVehiclesInput = {
  garageId: string;
  /** Only this import's vehicles. */
  importId?: string;
  /** Most vehicles to look up in this run. Default 50, at most 500. */
  limit?: number;
  /** Lookups in flight at once. Default 4. */
  concurrency?: number;
  /** Pause between batches, on top of the DVSA client's own pacing. Default 250 ms. */
  pauseMs?: number;
  /** Stop starting new batches after this long. Default 20 s. */
  budgetMs?: number;
  /** Tests: a service-role client and a lookup; defaults are the service role and the configured source. */
  client?: SupabaseClient | null;
  lookup?: EnrichmentLookup | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type EnrichImportedVehiclesResult = {
  /** Vehicles looked up in this run. */
  checked: number;
  /** MOT data written. */
  enriched: number;
  notFound: number;
  /** Lookups that failed (left pending, or marked failed after repeated errors). */
  failed: number;
  /** Pending vehicles are left for a later run. */
  remaining: boolean;
  stoppedReason: "done" | "limit" | "rate_limited" | "budget" | "not_configured" | "error";
  /** When stopped by a rate limit: wait at least this long. */
  retryAfterMs?: number;
};

type PendingVehicle = {
  id: string;
  registration: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  fuel: string | null;
  year: number | null;
  last_mileage: number | null;
  enrichment_attempts: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;
}

/** Columns to write for a successful lookup. */
export function enrichmentUpdate(vehicle: PendingVehicle, facts: EnrichmentFacts, checkedAt: Date) {
  const update: Record<string, unknown> = {
    enrichment_status: "done",
    mot_checked_at: checkedAt.toISOString(),
  };
  if (facts.motExpiry && ISO_DATE.test(facts.motExpiry)) update.mot_expiry = facts.motExpiry;
  if (Number.isInteger(facts.lastMileage) && facts.lastMileage! >= 0 && facts.lastMileage! <= 2_000_000
    && (vehicle.last_mileage === null || facts.lastMileage! > vehicle.last_mileage)) {
    update.last_mileage = facts.lastMileage;
  }
  const text = (value: string | undefined) => value?.trim().slice(0, 80) || undefined;
  if (!vehicle.make && text(facts.make)) update.make = text(facts.make);
  if (!vehicle.model && text(facts.model)) update.model = text(facts.model);
  if (!vehicle.colour && text(facts.colour)) update.colour = text(facts.colour);
  if (!vehicle.fuel && text(facts.fuel)) update.fuel = text(facts.fuel);
  if (!vehicle.year && Number.isInteger(facts.year) && facts.year! >= 1885 && facts.year! <= 2100) update.year = facts.year;
  return update;
}

/**
 * Looks up pending imported vehicles of one garage and stores their MOT
 * expiry and mileage. See the file comment for the contract.
 */
export async function enrichImportedVehicles(input: EnrichImportedVehiclesInput): Promise<EnrichImportedVehiclesResult> {
  const result: EnrichImportedVehiclesResult = { checked: 0, enriched: 0, notFound: 0, failed: 0, remaining: false, stoppedReason: "done" };
  const client = input.client === undefined ? createAdminClient() : input.client;
  const lookup = input.lookup === undefined ? getConfiguredEnrichmentLookup() : input.lookup;
  if (!client || !lookup) return { ...result, remaining: true, stoppedReason: "not_configured" };

  const limit = clampInteger(input.limit, 50, 1, 500);
  const concurrency = clampInteger(input.concurrency, 4, 1, 10);
  const pauseMs = clampInteger(input.pauseMs, 250, 0, 60_000);
  const budgetMs = clampInteger(input.budgetMs, 20_000, 0, 600_000);
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();

  let query = client
    .from("vehicles")
    .select("id,registration,make,model,colour,fuel,year,last_mileage,enrichment_attempts")
    .eq("garage_id", input.garageId)
    .eq("enrichment_status", "pending")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit + 1);
  if (input.importId) query = query.eq("import_id", input.importId);
  const { data, error } = await query;
  if (error) {
    console.warn("[customers.enrich] could not read pending vehicles", { garageId: input.garageId, code: error.code });
    return { ...result, remaining: true, stoppedReason: "error" };
  }
  const pending = (data ?? []) as PendingVehicle[];
  const work = pending.slice(0, limit);
  if (pending.length > limit) {
    result.remaining = true;
    result.stoppedReason = "limit";
  }

  const write = (vehicle: PendingVehicle, values: Record<string, unknown>) => client
    .from("vehicles")
    .update(values)
    .eq("garage_id", input.garageId)
    .eq("id", vehicle.id)
    .eq("enrichment_status", "pending");

  const enrichOne = async (vehicle: PendingVehicle): Promise<"ok" | "rate_limited"> => {
    if (!vehicle.registration) {
      await write(vehicle, { enrichment_status: "not_found" });
      result.notFound += 1;
      return "ok";
    }
    try {
      const facts = await lookup.lookup(vehicle.registration);
      result.checked += 1;
      const { error: updateError } = await write(vehicle, enrichmentUpdate(vehicle, facts, now()));
      if (updateError) {
        result.failed += 1;
        return "ok";
      }
      result.enriched += 1;
      return "ok";
    } catch (lookupError) {
      const code = lookupError instanceof VehicleLookupError ? lookupError.code : "unavailable";
      if (code === "rate_limited") {
        result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, lookupError instanceof VehicleLookupError ? lookupError.retryAfterMs ?? 60_000 : 60_000);
        return "rate_limited";
      }
      result.checked += 1;
      if (code === "not_found" || code === "invalid") {
        await write(vehicle, { enrichment_status: "not_found", mot_checked_at: now().toISOString() });
        result.notFound += 1;
        return "ok";
      }
      const attempts = vehicle.enrichment_attempts + 1;
      await write(vehicle, { enrichment_attempts: attempts, ...(attempts >= ENRICHMENT_MAX_ATTEMPTS ? { enrichment_status: "failed" } : {}) });
      result.failed += 1;
      return "ok";
    }
  };

  for (let index = 0; index < work.length; index += concurrency) {
    if (index > 0) {
      if (Date.now() - startedAt >= budgetMs) {
        result.remaining = true;
        result.stoppedReason = "budget";
        return result;
      }
      if (pauseMs) await sleep(pauseMs);
    }
    const outcomes = await Promise.all(work.slice(index, index + concurrency).map(enrichOne));
    if (outcomes.includes("rate_limited")) {
      result.remaining = true;
      result.stoppedReason = "rate_limited";
      return result;
    }
  }
  // Failures still pending need another run.
  if (!result.remaining && result.failed > 0) {
    const { count } = await client
      .from("vehicles")
      .select("id", { count: "exact", head: true })
      .eq("garage_id", input.garageId)
      .eq("enrichment_status", "pending");
    result.remaining = (count ?? 0) > 0;
  }
  return result;
}
