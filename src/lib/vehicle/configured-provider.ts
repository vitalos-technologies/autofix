import "server-only";

// Chooses the vehicle lookup provider from env. Readiness reports names only:
// values are never returned, logged or put in errors.
//
// VEHICLE_LOOKUP_PROVIDER:
// - unset: `mock` outside production; on a Vercel production deployment SOB's
//   old default `vehicle-data-global`.
// - `mock`: fake vehicle, no network. Refused on Vercel production (fails closed).
// - `composite`: DVLA VES + DVSA MOT History in parallel, Vehicle Data Global only
//   when make or model is missing. Each source is used only when its credentials
//   are set; the vehicle_facts cache is shared through Supabase when
//   VEHICLE_FACTS_PEPPER and the service role are set, otherwise per instance.
// - `dvla`, `vehicle-data-global`: single-source providers kept from SOB.
// Anything else, or a mode without credentials, returns null and the lookup
// route answers "not configured, continue manually".

import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { createCompositeProvider } from "./composite";
import { DvlaProvider, type DvlaEnvironment } from "./dvla";
import { DvsaMotHistoryClient, DVSA_MOT_DEFAULT_SCOPE, type DvsaCredentials, type MotHistoryLookup } from "./dvsa";
import {
  createMemoryVehicleFactsCache,
  createSupabaseVehicleFactsCache,
  VEHICLE_FACTS_PEPPER_MIN_LENGTH,
} from "./facts-cache";
import { mockVehicleProvider } from "./mock";
import { vehicleLookupError, type VehicleLookupProvider, type VehicleSourceName } from "./provider";
import { VehicleDataGlobalProvider } from "./vehicle-data-global";

export type VehicleLookupEnv = Readonly<Record<string, string | undefined>>;
export type VehicleLookupMode = "mock" | "dvla" | "vehicle-data-global" | "composite";

export type VehicleLookupReadiness = {
  provider: VehicleLookupMode | "invalid";
  /** `operational` (real sources), `mock`, or `configuration_required` (lookups fall back to manual entry). */
  status: "operational" | "mock" | "configuration_required";
  /** Sources this deployment will call. Names only. */
  sources: VehicleSourceName[];
  /** Where vehicle facts are cached. */
  cache: "supabase" | "memory" | "none";
  /** Names of missing or malformed variables (never values). */
  missing: string[];
};

const MODES: readonly VehicleLookupMode[] = ["mock", "dvla", "vehicle-data-global", "composite"];

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isProduction(env: VehicleLookupEnv) {
  return env.VERCEL_ENV === "production" && env.PLAYWRIGHT_TEST !== "true";
}

export function resolveVehicleLookupMode(env: VehicleLookupEnv = process.env): VehicleLookupMode | "invalid" {
  const raw = clean(env.VEHICLE_LOOKUP_PROVIDER)?.toLowerCase();
  if (!raw) return isProduction(env) ? "vehicle-data-global" : "mock";
  return (MODES as readonly string[]).includes(raw) ? (raw as VehicleLookupMode) : "invalid";
}

type DvlaConfig = { apiKey: string; environment: DvlaEnvironment };
type VdgConfig = { apiKey: string; baseUrl: string; packageName: string };

function readDvla(env: VehicleLookupEnv): { config?: DvlaConfig; missing: string[] } {
  // DVLA_API_KEY is SOB's name for the same key; DVLA_VES_API_KEY wins.
  const apiKey = clean(env.DVLA_VES_API_KEY) ?? clean(env.DVLA_API_KEY);
  const rawEnvironment = clean(env.DVLA_VES_ENVIRONMENT)?.toLowerCase() ?? "live";
  const missing: string[] = [];
  if (!apiKey) missing.push("DVLA_VES_API_KEY");
  if (rawEnvironment !== "live" && rawEnvironment !== "uat") missing.push("DVLA_VES_ENVIRONMENT");
  return missing.length || !apiKey
    ? { missing }
    : { config: { apiKey, environment: rawEnvironment as DvlaEnvironment }, missing };
}

function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function readDvsa(env: VehicleLookupEnv): { config?: DvsaCredentials; missing: string[] } {
  const clientId = clean(env.DVSA_MOT_CLIENT_ID);
  const clientSecret = clean(env.DVSA_MOT_CLIENT_SECRET);
  const apiKey = clean(env.DVSA_MOT_API_KEY);
  const tokenUrl = clean(env.DVSA_MOT_TOKEN_URL);
  const scope = clean(env.DVSA_MOT_SCOPE) ?? DVSA_MOT_DEFAULT_SCOPE;
  const missing: string[] = [];
  if (!clientId) missing.push("DVSA_MOT_CLIENT_ID");
  if (!clientSecret) missing.push("DVSA_MOT_CLIENT_SECRET");
  if (!apiKey) missing.push("DVSA_MOT_API_KEY");
  if (!tokenUrl || !isHttpsUrl(tokenUrl)) missing.push("DVSA_MOT_TOKEN_URL");
  if (missing.length || !clientId || !clientSecret || !apiKey || !tokenUrl) return { missing };
  return { config: { clientId, clientSecret, apiKey, tokenUrl, scope }, missing };
}

function readVdg(env: VehicleLookupEnv): { config?: VdgConfig; missing: string[] } {
  const apiKey = clean(env.VEHICLE_DATA_GLOBAL_API_KEY);
  const baseUrl = clean(env.VEHICLE_DATA_GLOBAL_BASE_URL);
  const packageName = clean(env.VEHICLE_DATA_GLOBAL_PACKAGE);
  const missing: string[] = [];
  if (!apiKey) missing.push("VEHICLE_DATA_GLOBAL_API_KEY");
  if (!baseUrl || !isHttpsUrl(baseUrl)) missing.push("VEHICLE_DATA_GLOBAL_BASE_URL");
  if (!packageName) missing.push("VEHICLE_DATA_GLOBAL_PACKAGE");
  if (missing.length || !apiKey || !baseUrl || !packageName) return { missing };
  return { config: { apiKey, baseUrl, packageName }, missing };
}

function readPepper(env: VehicleLookupEnv) {
  const pepper = clean(env.VEHICLE_FACTS_PEPPER);
  return pepper && pepper.length >= VEHICLE_FACTS_PEPPER_MIN_LENGTH ? pepper : undefined;
}

function hasSupabaseServiceRole(env: VehicleLookupEnv) {
  return Boolean(clean(env.NEXT_PUBLIC_SUPABASE_URL) && clean(env.SUPABASE_SECRET_KEY));
}

/** For /api/health and the admin: which sources a lookup will use, without exposing any value. */
export function getVehicleLookupReadiness(env: VehicleLookupEnv = process.env): VehicleLookupReadiness {
  const provider = resolveVehicleLookupMode(env);
  const none = { sources: [] as VehicleSourceName[], cache: "none" as const };

  if (provider === "invalid") return { provider, status: "configuration_required", ...none, missing: ["VEHICLE_LOOKUP_PROVIDER"] };
  if (provider === "mock") {
    return isProduction(env)
      ? { provider, status: "configuration_required", ...none, missing: ["VEHICLE_LOOKUP_PROVIDER"] }
      : { provider, status: "mock", ...none, missing: [] };
  }
  if (provider === "dvla") {
    const dvla = readDvla(env);
    return dvla.config
      ? { provider, status: "operational", sources: ["dvla"], cache: "none", missing: [] }
      : { provider, status: "configuration_required", ...none, missing: dvla.missing };
  }
  if (provider === "vehicle-data-global") {
    const vdg = readVdg(env);
    return vdg.config
      ? { provider, status: "operational", sources: ["vdg"], cache: "none", missing: [] }
      : { provider, status: "configuration_required", ...none, missing: vdg.missing };
  }

  const dvla = readDvla(env);
  const dvsa = readDvsa(env);
  const vdg = readVdg(env);
  const sources: VehicleSourceName[] = [];
  if (dvla.config) sources.push("dvla");
  if (dvsa.config) sources.push("dvsa");
  if (vdg.config) sources.push("vdg");
  const pepper = readPepper(env);
  const missing = [...dvla.missing, ...dvsa.missing, ...vdg.missing];
  if (!pepper) missing.push("VEHICLE_FACTS_PEPPER");
  return {
    provider,
    status: sources.length ? "operational" : "configuration_required",
    sources,
    cache: sources.length ? (pepper && hasSupabaseServiceRole(env) ? "supabase" : "memory") : "none",
    missing,
  };
}

// Providers are reused across requests so the DVSA token, cooldowns and the
// memory cache survive. The memo key is a hash of the config, never the values.
let memo: { key: string; provider: VehicleLookupProvider } | undefined;

function memoized(parts: unknown[], build: () => VehicleLookupProvider) {
  const key = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  if (memo?.key !== key) memo = { key, provider: build() };
  return memo.provider;
}

export function getConfiguredVehicleProvider(env: VehicleLookupEnv = process.env): VehicleLookupProvider | null {
  const readiness = getVehicleLookupReadiness(env);
  if (readiness.status === "configuration_required") return null;
  if (readiness.provider === "mock") return mockVehicleProvider;

  if (readiness.provider === "dvla") {
    const { config } = readDvla(env);
    return config ? memoized(["dvla", config], () => new DvlaProvider(config)) : null;
  }
  if (readiness.provider === "vehicle-data-global") {
    const { config } = readVdg(env);
    return config ? memoized(["vdg", config], () => new VehicleDataGlobalProvider(config.apiKey, config.baseUrl, config.packageName)) : null;
  }

  const dvla = readDvla(env).config;
  const dvsa = readDvsa(env).config;
  const vdg = readVdg(env).config;
  const pepper = readPepper(env);
  const cacheKind = readiness.cache;
  return memoized(["composite", dvla, dvsa, vdg, pepper, cacheKind], () => createCompositeProvider({
    dvla: dvla ? new DvlaProvider(dvla) : null,
    dvsa: dvsa ? new DvsaMotHistoryClient(dvsa) : null,
    vdg: vdg ? new VehicleDataGlobalProvider(vdg.apiKey, vdg.baseUrl, vdg.packageName) : null,
    cache: cacheKind === "supabase" ? createSupabaseVehicleFactsCache({ client: () => createAdminClient() }) : createMemoryVehicleFactsCache(),
    // Without a configured pepper the memory cache uses a per-instance random one.
    pepper: pepper ?? randomBytes(32).toString("hex"),
  }));
}

/** Test hook: drop the memoised provider. */
export function resetConfiguredVehicleProviderForTests() {
  memo = undefined;
  enrichmentMemo = undefined;
  motMemo = undefined;
}

/** What background enrichment needs from a vehicle source: MOT expiry, mileage and basic facts. */
export type EnrichmentFacts = {
  motExpiry?: string;
  lastMileage?: number;
  make?: string;
  model?: string;
  colour?: string;
  fuel?: string;
  year?: number;
};

export type EnrichmentLookup = {
  source: "mock" | "dvsa" | "dvla";
  lookup(registration: string): Promise<EnrichmentFacts>;
};

const KM_PER_MILE = 1.609344;
let enrichmentMemo: { key: string; lookup: EnrichmentLookup } | undefined;

/**
 * The free source background enrichment (P3.11) uses, never the paid Vehicle
 * Data Global: `mock` in mock mode; DVSA MOT History (expiry and mileage)
 * whenever its credentials are set; otherwise DVLA VES (expiry only) when
 * configured. Null when none is available. The DVSA client paces itself below
 * DVSA's rate limit and is reused across calls.
 */
export function getConfiguredEnrichmentLookup(env: VehicleLookupEnv = process.env): EnrichmentLookup | null {
  const readiness = getVehicleLookupReadiness(env);
  if (readiness.status === "configuration_required") return null;
  if (readiness.provider === "mock") {
    return {
      source: "mock",
      async lookup(registration) {
        const vehicle = await mockVehicleProvider.lookup(registration);
        return { motExpiry: vehicle.motExpiry, make: vehicle.make, model: vehicle.model, fuel: vehicle.fuelType, year: vehicle.year };
      },
    };
  }
  const dvsa = readDvsa(env).config;
  const dvla = readDvla(env).config;
  if (!dvsa && !dvla) return null;
  const key = createHash("sha256").update(JSON.stringify(["enrichment", dvsa, dvla])).digest("hex");
  if (enrichmentMemo?.key === key) return enrichmentMemo.lookup;

  let lookup: EnrichmentLookup;
  if (dvsa) {
    const client = new DvsaMotHistoryClient(dvsa);
    lookup = {
      source: "dvsa",
      async lookup(registration) {
        const vehicle = await client.getMotHistory(registration);
        const mileage = vehicle.mot.lastMileage;
        return {
          motExpiry: vehicle.mot.motExpiry,
          lastMileage: mileage === undefined ? undefined : Math.round(vehicle.mot.mileageUnit === "km" ? mileage / KM_PER_MILE : mileage),
          make: vehicle.make,
          model: vehicle.model,
          colour: vehicle.colour,
          fuel: vehicle.fuelType,
          year: vehicle.year,
        };
      },
    };
  } else {
    const provider = new DvlaProvider(dvla!);
    lookup = {
      source: "dvla",
      async lookup(registration) {
        const vehicle = await provider.lookup(registration);
        return { motExpiry: vehicle.motExpiry, make: vehicle.make, colour: vehicle.colour, fuel: vehicle.fuelType, year: vehicle.year };
      },
    };
  }
  enrichmentMemo = { key, lookup };
  return lookup;
}

// ---------------------------------------------------------------------------------------------
// MOT history for the nightly refresh (`mot.refresh`, SPEC "Nightly MOT refresh")

let motMemo: { key: string; lookup: MotHistoryLookup } | undefined;

/**
 * Development and test stand-in: knows no vehicle, so a refresh only records that each car was
 * checked and never changes an MOT date (seeded reminders stay as they are).
 */
export const mockMotHistoryLookup: MotHistoryLookup = {
  async getMotHistory() {
    throw vehicleLookupError("not_found", { source: "dvsa" });
  },
};

/**
 * The DVSA MOT History client when its credentials are set; the mock outside production when the
 * lookup provider is `mock` (or unset); otherwise null and the refresh reports "not configured".
 */
export function getConfiguredMotHistoryLookup(env: VehicleLookupEnv = process.env): MotHistoryLookup | null {
  const dvsa = readDvsa(env).config;
  if (dvsa) {
    const key = createHash("sha256").update(JSON.stringify(["dvsa-mot", dvsa])).digest("hex");
    if (motMemo?.key !== key) motMemo = { key, lookup: new DvsaMotHistoryClient(dvsa) };
    return motMemo.lookup;
  }
  if (!isProduction(env) && resolveVehicleLookupMode(env) === "mock") return mockMotHistoryLookup;
  return null;
}
