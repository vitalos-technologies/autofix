import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn(() => null) }));

import {
  getConfiguredVehicleProvider,
  getVehicleLookupReadiness,
  resetConfiguredVehicleProviderForTests,
  resolveVehicleLookupMode,
} from "@/lib/vehicle/configured-provider";
import { mockVehicleProvider } from "@/lib/vehicle/mock";

const secrets = {
  DVLA_VES_API_KEY: "fake-dvla-secret-value",
  DVSA_MOT_CLIENT_ID: "fake-dvsa-client-id-value",
  DVSA_MOT_CLIENT_SECRET: "fake-dvsa-client-secret-value",
  DVSA_MOT_API_KEY: "fake-dvsa-api-key-value",
  DVSA_MOT_TOKEN_URL: "https://login.microsoftonline.com/fake-tenant-value/oauth2/v2.0/token",
  DVSA_MOT_SCOPE: "https://tapi.dvsa.gov.uk/.default",
  VEHICLE_DATA_GLOBAL_API_KEY: "fake-vdg-secret-value",
  VEHICLE_DATA_GLOBAL_BASE_URL: "https://uk.api.vehicledataglobal.com",
  VEHICLE_DATA_GLOBAL_PACKAGE: "VehicleDetails",
  VEHICLE_FACTS_PEPPER: "fake-pepper-value-0123456789abcdef0123456789",
  NEXT_PUBLIC_SUPABASE_URL: "https://fake-project.supabase.co",
  SUPABASE_SECRET_KEY: "fake-supabase-secret-value",
};

function expectNoValues(readiness: unknown) {
  const text = JSON.stringify(readiness);
  for (const [name, value] of Object.entries(secrets)) {
    if (name === "DVSA_MOT_SCOPE" || name === "VEHICLE_DATA_GLOBAL_BASE_URL" || name === "VEHICLE_DATA_GLOBAL_PACKAGE") continue;
    expect(text).not.toContain(value);
  }
}

describe("vehicle lookup mode", () => {
  it("defaults to mock outside production and to SOB's provider on Vercel production", () => {
    expect(resolveVehicleLookupMode({})).toBe("mock");
    expect(resolveVehicleLookupMode({ VERCEL_ENV: "preview" })).toBe("mock");
    expect(resolveVehicleLookupMode({ VERCEL_ENV: "production" })).toBe("vehicle-data-global");
  });

  it("keeps the existing values and adds composite", () => {
    for (const mode of ["mock", "dvla", "vehicle-data-global", "composite"]) {
      expect(resolveVehicleLookupMode({ VEHICLE_LOOKUP_PROVIDER: ` ${mode.toUpperCase()} ` })).toBe(mode);
    }
    expect(resolveVehicleLookupMode({ VEHICLE_LOOKUP_PROVIDER: "ukvd" })).toBe("invalid");
  });
});

describe("getVehicleLookupReadiness", () => {
  it("reports mock in development and fails closed for mock on production", () => {
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "mock" })).toEqual({ provider: "mock", status: "mock", sources: [], cache: "none", missing: [] });
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "mock", VERCEL_ENV: "production" })).toMatchObject({ status: "configuration_required", missing: ["VEHICLE_LOOKUP_PROVIDER"] });
    // Playwright runs production builds with the mock on purpose.
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "mock", VERCEL_ENV: "production", PLAYWRIGHT_TEST: "true" }).status).toBe("mock");
  });

  it("lists every configured composite source by name", () => {
    const readiness = getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "composite", ...secrets });
    expect(readiness).toEqual({ provider: "composite", status: "operational", sources: ["dvla", "dvsa", "vdg"], cache: "supabase", missing: [] });
    expectNoValues(readiness);
  });

  it("enables each composite source only when its credentials are set", () => {
    const readiness = getVehicleLookupReadiness({
      VEHICLE_LOOKUP_PROVIDER: "composite",
      DVLA_VES_API_KEY: secrets.DVLA_VES_API_KEY,
      DVSA_MOT_CLIENT_ID: secrets.DVSA_MOT_CLIENT_ID,
      DVSA_MOT_TOKEN_URL: "http://not-https.example/token",
    });
    expect(readiness).toMatchObject({ status: "operational", sources: ["dvla"], cache: "memory" });
    expect(readiness.missing).toEqual([
      "DVSA_MOT_CLIENT_SECRET",
      "DVSA_MOT_API_KEY",
      "DVSA_MOT_TOKEN_URL",
      "VEHICLE_DATA_GLOBAL_API_KEY",
      "VEHICLE_DATA_GLOBAL_BASE_URL",
      "VEHICLE_DATA_GLOBAL_PACKAGE",
      "VEHICLE_FACTS_PEPPER",
    ]);
    expectNoValues(readiness);
  });

  it("needs configuration when composite has no source", () => {
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "composite" })).toMatchObject({ status: "configuration_required", sources: [], cache: "none" });
  });

  it("treats a short pepper as missing and keeps the cache in memory", () => {
    const readiness = getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "composite", ...secrets, VEHICLE_FACTS_PEPPER: "short" });
    expect(readiness.cache).toBe("memory");
    expect(readiness.missing).toEqual(["VEHICLE_FACTS_PEPPER"]);
  });

  it("accepts SOB's DVLA_API_KEY for the dvla mode", () => {
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "dvla", DVLA_API_KEY: "legacy" })).toMatchObject({ status: "operational", sources: ["dvla"] });
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "dvla" })).toMatchObject({ status: "configuration_required", missing: ["DVLA_VES_API_KEY"] });
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "dvla", DVLA_VES_API_KEY: "x", DVLA_VES_ENVIRONMENT: "staging" })).toMatchObject({ status: "configuration_required", missing: ["DVLA_VES_ENVIRONMENT"] });
  });

  it("flags an unknown provider", () => {
    expect(getVehicleLookupReadiness({ VEHICLE_LOOKUP_PROVIDER: "ukvd" })).toMatchObject({ provider: "invalid", status: "configuration_required", missing: ["VEHICLE_LOOKUP_PROVIDER"] });
  });
});

describe("getConfiguredVehicleProvider", () => {
  beforeEach(() => resetConfiguredVehicleProviderForTests());

  it("returns the mock provider in development", () => {
    expect(getConfiguredVehicleProvider({})).toBe(mockVehicleProvider);
    expect(getConfiguredVehicleProvider({ VEHICLE_LOOKUP_PROVIDER: "mock" })).toBe(mockVehicleProvider);
  });

  it("returns null (manual entry) when the chosen provider is not configured", () => {
    expect(getConfiguredVehicleProvider({ VEHICLE_LOOKUP_PROVIDER: "composite" })).toBeNull();
    expect(getConfiguredVehicleProvider({ VEHICLE_LOOKUP_PROVIDER: "vehicle-data-global" })).toBeNull();
    expect(getConfiguredVehicleProvider({ VEHICLE_LOOKUP_PROVIDER: "mock", VERCEL_ENV: "production" })).toBeNull();
    expect(getConfiguredVehicleProvider({ VERCEL_ENV: "production" })).toBeNull();
  });

  it("builds the composite once and reuses it while the config is unchanged", () => {
    const env = { VEHICLE_LOOKUP_PROVIDER: "composite", ...secrets };
    const first = getConfiguredVehicleProvider(env);
    expect(first).not.toBeNull();
    expect(first).toHaveProperty("lookupFacts");
    expect(getConfiguredVehicleProvider({ ...env })).toBe(first);
    expect(getConfiguredVehicleProvider({ ...env, DVLA_VES_API_KEY: "rotated" })).not.toBe(first);
  });

  it("builds single-source providers for the kept SOB modes", () => {
    expect(getConfiguredVehicleProvider({ VEHICLE_LOOKUP_PROVIDER: "dvla", DVLA_VES_API_KEY: "x" })).not.toBeNull();
    expect(getConfiguredVehicleProvider({ VEHICLE_LOOKUP_PROVIDER: "vehicle-data-global", ...secrets })).not.toBeNull();
  });
});
