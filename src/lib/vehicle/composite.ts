import "server-only";

// CompositeProvider: DVLA VES + DVSA MOT History in parallel, Vehicle Data
// Global (paid) only when make or model is still missing, behind the existing
// VehicleLookupProvider interface, with a 24-hour vehicle_facts cache.
//
// Merge rules:
// - make, colour, fuel, year, engine size: DVLA, then DVSA, then VDG.
// - model: VDG (when it was called), then DVSA. Derivative, transmission, body: VDG.
// - MOT expiry: DVSA (latest passed test, or first-MOT due date), then DVLA, then VDG.
// - MOT status: derived from DVSA's expiry when DVSA has tests ("Valid" while the
//   expiry is today or later in Europe/London, else "Not valid"), otherwise DVLA's label.
// - Tax status and due date: DVLA.
// If no source answers, the lookup fails with `not_found` so the customer enters
// the car by hand (or `invalid` when every source rejected the registration).
//
// MOT fields always pass through; callers hide them unless garages.mot_enabled.
// Answers are cached only when no source failed transiently, so a DVSA outage
// does not pin a vehicle without MOT data for a day. Registrations are never
// logged, cached or put in errors; in-flight de-duplication keys are hashes.

import { createHmac, randomBytes } from "node:crypto";
import type { VehicleDetails } from "@/types/domain";
import { londonIsoDate, type DvsaVehicle, type MotHistory, type MotHistoryLookup } from "./dvsa";
import {
  hashRegistration,
  isFresh,
  toStoredFacts,
  VEHICLE_FACTS_MAX_AGE_MS,
  type VehicleFacts,
  type VehicleFactsCache,
  type VehicleLogger,
} from "./facts-cache";
import {
  vehicleLookupError,
  VehicleLookupError,
  type VehicleLookupErrorCode,
  type VehicleLookupProvider,
  type VehicleSourceName,
} from "./provider";
import { normalizeRegistration } from "./registration-format";

export type CompositeProviderOptions = {
  dvla?: VehicleLookupProvider | null;
  dvsa?: MotHistoryLookup | null;
  vdg?: VehicleLookupProvider | null;
  cache?: VehicleFactsCache | null;
  /** VEHICLE_FACTS_PEPPER. The cache is used only when both cache and pepper are set. */
  pepper?: string;
  now?: () => Date;
  maxAgeMs?: number;
  logger?: VehicleLogger;
};

export type VehicleFactsResult = {
  vehicle: VehicleDetails;
  /** DVSA MOT history, when DVSA answered. */
  mot?: MotHistory;
  /** Sources whose data is in the result. */
  sources: VehicleSourceName[];
  cached: boolean;
  /** ISO date-time the facts were fetched from the sources. */
  fetchedAt: string;
};

export interface CompositeVehicleProvider extends VehicleLookupProvider {
  /** Vehicle plus MOT history and provenance, for internal callers (admin, jobs). */
  lookupFacts(registration: string): Promise<VehicleFactsResult>;
}

type Outcome<T> =
  | { status: "skipped" }
  | { status: "ok"; value: T }
  | { status: "error"; code: VehicleLookupErrorCode; error?: VehicleLookupError };

function settled<T>(result: PromiseSettledResult<T> | undefined): Outcome<T> {
  if (!result) return { status: "skipped" };
  if (result.status === "fulfilled") return { status: "ok", value: result.value };
  const error = result.reason instanceof VehicleLookupError ? result.reason : undefined;
  return { status: "error", code: error?.code ?? "unavailable", error };
}

function valueOf<T>(outcome: Outcome<T>) {
  return outcome.status === "ok" ? outcome.value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

/** Combine the sources' answers using the merge rules above. `today` is the ISO date in Europe/London. */
export function mergeVehicleFacts(
  input: { dvla?: VehicleDetails; dvsa?: DvsaVehicle; vdg?: VehicleDetails },
  today: string,
): VehicleFacts {
  const { dvla, dvsa, vdg } = input;
  const dvsaHasTests = Boolean(dvsa?.mot.motTests.length);
  const dvsaExpiry = dvsa?.mot.motExpiry;
  const motExpiry = dvsaExpiry ?? dvla?.motExpiry ?? vdg?.motExpiry;
  const motStatus = dvsaHasTests && dvsaExpiry
    ? (dvsaExpiry >= today ? "Valid" : "Not valid")
    : dvla?.motStatus ?? vdg?.motStatus;

  const vehicle = compact({
    make: dvla?.make ?? dvsa?.make ?? vdg?.make,
    model: vdg?.model ?? dvsa?.model,
    derivative: vdg?.derivative,
    year: dvla?.year ?? dvsa?.year ?? vdg?.year,
    colour: dvla?.colour ?? dvsa?.colour ?? vdg?.colour,
    fuelType: dvla?.fuelType ?? dvsa?.fuelType ?? vdg?.fuelType,
    transmission: vdg?.transmission,
    engineCapacityCc: dvla?.engineCapacityCc ?? dvsa?.engineCapacityCc ?? vdg?.engineCapacityCc,
    bodyType: vdg?.bodyType,
    motStatus,
    motExpiry,
    taxStatus: dvla?.taxStatus,
    taxDueDate: dvla?.taxDueDate,
  });

  const sources: VehicleSourceName[] = [];
  if (dvla) sources.push("dvla");
  if (dvsa) sources.push("dvsa");
  if (vdg) sources.push("vdg");

  const facts: VehicleFacts = { version: 1, vehicle, sources };
  if (dvsa) facts.mot = compact({ ...dvsa.mot }) as MotHistory;
  return facts;
}

const REGISTRATION = /^[A-Z0-9]{2,8}$/;

export function createCompositeProvider(options: CompositeProviderOptions): CompositeVehicleProvider {
  const { dvla, dvsa, vdg } = options;
  const cache = options.cache && options.pepper ? options.cache : null;
  const pepper = options.pepper ?? "";
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? VEHICLE_FACTS_MAX_AGE_MS;
  const logger = options.logger ?? console;
  // Keys for in-flight de-duplication; a per-instance secret so plates are never map keys.
  const inflightPepper = randomBytes(32);
  const inflight = new Map<string, Promise<VehicleFactsResult>>();

  function warnSourceFailure(source: VehicleSourceName, outcome: Outcome<unknown>) {
    if (outcome.status !== "error" || outcome.code === "not_found" || outcome.code === "invalid") return;
    logger.warn("[vehicle] source lookup failed", {
      source,
      code: outcome.code,
      status: outcome.error?.status,
      upstreamCode: outcome.error?.upstreamCode,
    });
  }

  async function readCache(regHash: string) {
    if (!cache) return null;
    try {
      const hit = await cache.get(regHash);
      if (!hit || !isFresh(hit.fetchedAt, now(), maxAgeMs)) return null;
      const facts = toStoredFacts(hit.facts);
      return facts ? { facts, fetchedAt: hit.fetchedAt } : null;
    } catch {
      logger.warn("[vehicle] facts cache read failed; treating as a miss");
      return null;
    }
  }

  async function writeCache(regHash: string, facts: VehicleFacts, fetchedAt: Date) {
    if (!cache) return;
    try {
      await cache.set(regHash, facts, fetchedAt);
    } catch {
      logger.warn("[vehicle] facts cache write failed");
    }
  }

  function result(registration: string, facts: VehicleFacts, cached: boolean, fetchedAt: Date): VehicleFactsResult {
    const value: VehicleFactsResult = {
      vehicle: { registration, ...facts.vehicle },
      sources: [...facts.sources],
      cached,
      fetchedAt: fetchedAt.toISOString(),
    };
    if (facts.mot) value.mot = facts.mot;
    return value;
  }

  async function resolve(registration: string, regHash: string | undefined): Promise<VehicleFactsResult> {
    if (regHash) {
      const hit = await readCache(regHash);
      if (hit) return result(registration, hit.facts, true, hit.fetchedAt);
    }

    // Promise.resolve().then(...) also captures a source that throws synchronously.
    const [dvlaSettled, dvsaSettled] = await Promise.allSettled([
      Promise.resolve().then(() => dvla?.lookup(registration)),
      Promise.resolve().then(() => dvsa?.getMotHistory(registration)),
    ]);
    const dvlaOutcome = dvla ? settled(dvlaSettled) : ({ status: "skipped" } as const);
    const dvsaOutcome = dvsa ? settled(dvsaSettled) : ({ status: "skipped" } as const);
    const today = londonIsoDate(now());
    const partial = mergeVehicleFacts({ dvla: valueOf(dvlaOutcome), dvsa: valueOf(dvsaOutcome) }, today);

    let vdgOutcome: Outcome<VehicleDetails> = { status: "skipped" };
    if (vdg && (!partial.vehicle.make || !partial.vehicle.model)) {
      const [vdgSettled] = await Promise.allSettled([Promise.resolve().then(() => vdg.lookup(registration))]);
      vdgOutcome = settled(vdgSettled);
    }

    const outcomes = { dvla: dvlaOutcome, dvsa: dvsaOutcome, vdg: vdgOutcome } as const;
    for (const [source, outcome] of Object.entries(outcomes)) warnSourceFailure(source as VehicleSourceName, outcome);

    const answered = Object.values(outcomes).some((outcome) => outcome.status === "ok");
    if (!answered) {
      const sourceErrors: Partial<Record<VehicleSourceName, VehicleLookupErrorCode>> = {};
      for (const [source, outcome] of Object.entries(outcomes)) {
        if (outcome.status === "error") sourceErrors[source as VehicleSourceName] = outcome.code;
      }
      const codes = Object.values(sourceErrors);
      const code = codes.length > 0 && codes.every((item) => item === "invalid") ? "invalid" : "not_found";
      throw vehicleLookupError(code, { source: "composite", sourceErrors });
    }

    const facts = mergeVehicleFacts({ dvla: valueOf(dvlaOutcome), dvsa: valueOf(dvsaOutcome), vdg: valueOf(vdgOutcome) }, today);
    const fetchedAt = now();
    const transient = Object.values(outcomes).some(
      (outcome) => outcome.status === "error" && outcome.code !== "not_found" && outcome.code !== "invalid",
    );
    if (regHash && !transient) await writeCache(regHash, facts, fetchedAt);
    return result(registration, facts, false, fetchedAt);
  }

  async function lookupFacts(input: string): Promise<VehicleFactsResult> {
    const registration = normalizeRegistration(input);
    if (!REGISTRATION.test(registration)) throw vehicleLookupError("invalid", { source: "composite" });
    if (!dvla && !dvsa && !vdg) throw vehicleLookupError("unavailable", { source: "composite" });

    const regHash = cache ? hashRegistration(registration, pepper) : undefined;
    const key = createHmac("sha256", inflightPepper).update(registration).digest("hex");
    let pending = inflight.get(key);
    if (!pending) {
      pending = resolve(registration, regHash).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return structuredClone(await pending);
  }

  return {
    lookupFacts,
    async lookup(registration) {
      return (await lookupFacts(registration)).vehicle;
    },
  };
}
