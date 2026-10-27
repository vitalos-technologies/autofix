import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn(() => null) }));

import { GET } from "@/app/api/health/route";

describe("/api/health vehicle lookup readiness", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists configured source names without any value", async () => {
    vi.stubEnv("VEHICLE_LOOKUP_PROVIDER", "composite");
    vi.stubEnv("DVLA_VES_API_KEY", "fake-dvla-secret-value");
    vi.stubEnv("DVSA_MOT_CLIENT_ID", "fake-dvsa-client-id-value");
    vi.stubEnv("DVSA_MOT_CLIENT_SECRET", "fake-dvsa-client-secret-value");
    vi.stubEnv("DVSA_MOT_API_KEY", "fake-dvsa-api-key-value");
    vi.stubEnv("DVSA_MOT_TOKEN_URL", "https://login.microsoftonline.com/fake-tenant-value/oauth2/v2.0/token");
    vi.stubEnv("VEHICLE_DATA_GLOBAL_API_KEY", "");
    vi.stubEnv("VEHICLE_FACTS_PEPPER", "");

    const response = await GET();
    const text = await response.text();
    const body = JSON.parse(text) as { checks: { vehicleLookup: unknown } };

    expect(body.checks.vehicleLookup).toEqual({ status: "operational", provider: "composite", sources: ["dvla", "dvsa"], cache: "memory" });
    for (const value of ["fake-dvla-secret-value", "fake-dvsa-client-id-value", "fake-dvsa-client-secret-value", "fake-dvsa-api-key-value", "fake-tenant-value"]) {
      expect(text).not.toContain(value);
    }
    // Variable names of missing settings stay out of the public health response.
    expect(text).not.toContain("VEHICLE_FACTS_PEPPER");
  });

  it("reports configuration_required when composite has no credentials", async () => {
    vi.stubEnv("VEHICLE_LOOKUP_PROVIDER", "composite");
    vi.stubEnv("DVLA_VES_API_KEY", "");
    vi.stubEnv("DVLA_API_KEY", "");
    vi.stubEnv("DVSA_MOT_CLIENT_ID", "");
    vi.stubEnv("VEHICLE_DATA_GLOBAL_API_KEY", "");
    const body = await (await GET()).json() as { checks: { vehicleLookup: { status: string; sources: string[] } } };
    expect(body.checks.vehicleLookup).toMatchObject({ status: "configuration_required", sources: [] });
  });
});
