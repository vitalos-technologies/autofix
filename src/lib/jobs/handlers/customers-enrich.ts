import "server-only";

import { enrichImportedVehicles } from "@/lib/customers/enrichment";
import type { EnrichmentLookup } from "@/lib/vehicle/configured-provider";
import { customersEnrichPayload, parsePayload } from "../payloads";
import { utcDate } from "../periods";
import { databaseError, retryableJobError, type JobHandler } from "../types";

// `customers.enrich` (P3.11's background DVSA enrichment of imported cars,
// src/lib/customers/enrichment.ts). Without a garage: one job per garage
// that has vehicles waiting (enrichment_status = pending), once a day. With
// a garage (and optionally one import): enrichImportedVehicles() within the
// attempt's time, then a continuation while vehicles remain: straight away
// after a full batch or the time limit, after Retry-After on a DVSA rate
// limit, and 15 minutes later when only failed lookups are left (each
// vehicle is marked failed after 3 attempts, so a DVSA outage does not burn
// them in one drain).

export const CUSTOMERS_ENRICH_BATCH = 50;
const FAILED_LOOKUP_RETRY_MS = 15 * 60 * 1000;

export type CustomersEnrichDeps = {
  enrich?: typeof enrichImportedVehicles;
  lookup?: (env: Readonly<Record<string, string | undefined>>) => EnrichmentLookup | null;
};

export function createCustomersEnrichHandler(deps: CustomersEnrichDeps = {}): JobHandler {
  const enrich = deps.enrich ?? enrichImportedVehicles;

  return async (payload, context) => {
    const input = parsePayload(customersEnrichPayload, payload, context.job);
    const now = context.now();

    if (!input.garageId) {
      const { data, error } = await context.db.from("vehicles").select("garage_id").eq("enrichment_status", "pending").limit(5000);
      if (error) throw databaseError("vehicles.pending_enrichment", error);
      const garages = [...new Set(((data ?? []) as Array<{ garage_id: string }>).map((row) => row.garage_id))];
      for (const garageId of garages) {
        await context.queue.enqueue("customers.enrich", { garageId }, { garageId, dedupeKey: `customers.enrich:${garageId}:${utcDate(now)}` });
      }
      return { outcome: "fanned_out", counts: { garages: garages.length } };
    }

    const garageId = input.garageId;
    const result = await enrich({
      garageId,
      ...(input.importId ? { importId: input.importId } : {}),
      limit: CUSTOMERS_ENRICH_BATCH,
      budgetMs: Math.max(0, context.deadline - context.clock()),
      client: context.db,
      ...(deps.lookup ? { lookup: deps.lookup(context.env) } : {}),
      now: context.now,
    });
    const counts = { checked: result.checked, enriched: result.enriched, not_found: result.notFound, failed: result.failed, more: result.remaining ? 1 : 0 };

    if (result.stoppedReason === "not_configured") {
      context.log.warn("enrichment_source_not_configured");
      return { outcome: "not_configured", counts };
    }
    if (result.stoppedReason === "error") throw retryableJobError("ENRICH_FAILED");

    if (result.remaining) {
      const later = result.stoppedReason === "rate_limited"
        ? result.retryAfterMs ?? 60_000
        : result.stoppedReason === "done" ? FAILED_LOOKUP_RETRY_MS : 0;
      await context.queue.enqueue("customers.enrich", { garageId, ...(input.importId ? { importId: input.importId } : {}) }, {
        garageId,
        ...(later > 0 ? { runAt: new Date(now.getTime() + later) } : {}),
        dedupeKey: `customers.enrich:${garageId}:${later > 0 ? "retry" : "more"}:${context.job.id}`,
      });
    }
    return { outcome: result.stoppedReason, counts };
  };
}

export const customersEnrichHandler = createCustomersEnrichHandler();
