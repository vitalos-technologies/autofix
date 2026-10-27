import { beforeEach, describe, expect, it, vi } from "vitest";

// getAdminContext(): membership-based access, the selected garage from the
// af_garage cookie (validated), an RLS client that sends x-garage-id, and
// SOB's MFA / trusted-device rules on top.

const garageA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Hartley Road Motors", status: "active" };
const garageB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Demo Garage B", status: "active" };
const garageC = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Other People's Garage", status: "active" };

const harness = vi.hoisted(() => ({
  user: null as { id: string; email?: string; user_metadata?: Record<string, unknown> } | null,
  memberships: [] as Array<{ garage_id: string; role: string; created_at: string; garage: { id: string; name: string; status: string } }>,
  garageRows: new Map<string, Record<string, unknown>>(),
  profile: null as { user_id: string; display_name: string } | null,
  assurance: { currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: [{ method: "password" }] },
  assuranceError: null as Error | null,
  cookies: new Map<string, string>(),
  trustedRecord: null as Record<string, unknown> | null,
  policy: null as { mandatory_mfa_enabled: boolean } | null,
  policyError: null as Error | null,
  clientHeaders: [] as Array<Record<string, string>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => harness.cookies.has(name) ? { name, value: harness.cookies.get(name) } : undefined,
    getAll: () => [...harness.cookies].map(([name, value]) => ({ name, value })),
    set: vi.fn(),
  })),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { global?: { headers?: Record<string, string> } }) => {
    const headers = options.global?.headers ?? {};
    harness.clientHeaders.push(headers);
    return {
      headers,
      auth: {
        getUser: vi.fn(async () => ({ data: { user: harness.user } })),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: harness.assurance, error: harness.assuranceError })),
        },
      },
      from: (table: string) => {
        const filters = new Map<string, unknown>();
        const query = {
          select: () => query,
          order: () => query,
          eq: (field: string, value: unknown) => {
            filters.set(field, value);
            return query;
          },
          maybeSingle: async () => {
            if (table === "admin_profiles") return { data: harness.profile, error: null };
            if (table === "garages") {
              // RLS stand-in: a garage row is visible only with a member's own x-garage-id.
              const id = String(filters.get("id"));
              const visible = headers["x-garage-id"] === id && harness.memberships.some((membership) => membership.garage_id === id);
              return { data: visible ? harness.garageRows.get(id) ?? null : null, error: null };
            }
            return { data: null, error: null };
          },
          then: (resolve: (value: unknown) => unknown) => {
            if (table === "garage_members") {
              const userId = filters.get("user_id");
              return Promise.resolve({ data: harness.user && userId === harness.user.id ? harness.memberships : [], error: null }).then(resolve);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
        return query;
      },
    };
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        update: () => query,
        is: () => query,
        maybeSingle: async () => ({
          data: table === "admin_mfa_policy" ? harness.policy : harness.trustedRecord,
          error: table === "admin_mfa_policy" ? harness.policyError : null,
        }),
      };
      return query;
    },
  }),
}));

import { hashTrustedDeviceToken } from "@/lib/auth/trusted-device";
import { GARAGE_COOKIE, getAdminContext, selectGarage } from "@/lib/tenancy/admin";

function membership(garage: typeof garageA, role = "owner", createdAt = "2026-10-01T09:00:00Z") {
  return { garage_id: garage.id, role, created_at: createdAt, garage };
}

function garageRow(garage: typeof garageA) {
  return { ...garage, slug: garage.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), booking_prefix: "HRM", email: "hello@example.test", address: { town: "Doncaster" }, garage_domains: [] };
}

describe("getAdminContext", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    harness.user = { id: "user-a", email: "owner@hartleyroad.example" };
    harness.memberships = [membership(garageA)];
    harness.garageRows = new Map([garageA, garageB, garageC].map((garage) => [garage.id, garageRow(garage)]));
    harness.profile = { user_id: "user-a", display_name: "Sam Owner" };
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: [{ method: "password" }] };
    harness.assuranceError = null;
    harness.cookies = new Map();
    harness.trustedRecord = null;
    harness.policy = { mandatory_mfa_enabled: false };
    harness.policyError = null;
    harness.clientHeaders = [];
  });

  it("returns the member's garage and an RLS client that sends x-garage-id", async () => {
    const context = await getAdminContext();
    expect(context).toMatchObject({
      user: { id: "user-a" },
      profile: { display_name: "Sam Owner" },
      garage: { id: garageA.id, name: garageA.name },
      role: "owner",
      memberships: [{ garageId: garageA.id, name: garageA.name, role: "owner" }],
    });
    expect((context?.client as unknown as { headers: Record<string, string> }).headers).toEqual({ "x-garage-id": garageA.id });
  });

  it("is null when signed out or when the user belongs to no garage", async () => {
    harness.user = null;
    await expect(getAdminContext()).resolves.toBeNull();

    harness.user = { id: "user-a", email: "owner@hartleyroad.example" };
    harness.memberships = [];
    await expect(getAdminContext()).resolves.toBeNull();
    await expect(getAdminContext({ requireMfa: false, allowTrustedDevice: true })).resolves.toBeNull();
  });

  it("uses a valid af_garage cookie to select among the user's garages", async () => {
    harness.memberships = [membership(garageA), membership(garageB, "manager", "2026-10-02T09:00:00Z")];
    harness.cookies.set(GARAGE_COOKIE, garageB.id);
    const context = await getAdminContext();
    expect(context?.garage.id).toBe(garageB.id);
    expect(context?.role).toBe("manager");
    expect(context?.memberships.map((item) => item.garageId)).toEqual([garageA.id, garageB.id]);
    expect(harness.clientHeaders.at(-1)).toEqual({ "x-garage-id": garageB.id });
  });

  it("falls back to the first membership for a forged, stale or malformed cookie", async () => {
    harness.memberships = [membership(garageA), membership(garageB, "manager", "2026-10-02T09:00:00Z")];
    for (const value of [garageC.id, "not-a-uuid", "", "00000000-0000-4000-8000-000000000000"]) {
      harness.cookies.set(GARAGE_COOKIE, value);
      harness.clientHeaders = [];
      const context = await getAdminContext();
      expect(context?.garage.id, value).toBe(garageA.id);
      expect(harness.clientHeaders.some((headers) => headers["x-garage-id"] === garageC.id), value).toBe(false);
    }
  });

  it("follows the cookie when a multi-garage user switches garage", async () => {
    harness.memberships = [membership(garageA), membership(garageB, "technician", "2026-10-02T09:00:00Z")];
    harness.cookies.set(GARAGE_COOKIE, garageA.id);
    expect((await getAdminContext())?.garage.id).toBe(garageA.id);
    harness.cookies.set(GARAGE_COOKIE, garageB.id);
    const switched = await getAdminContext();
    expect(switched?.garage.id).toBe(garageB.id);
    expect(switched?.role).toBe("technician");
  });

  it("leaves out cancelled garages and unknown roles", async () => {
    harness.memberships = [
      membership({ ...garageC, status: "cancelled" }),
      { ...membership(garageB), role: "intruder" },
      membership(garageA, "manager", "2026-10-03T09:00:00Z"),
    ];
    const context = await getAdminContext();
    expect(context?.memberships).toEqual([{ garageId: garageA.id, name: garageA.name, role: "manager" }]);
    expect(context?.garage.id).toBe(garageA.id);
  });

  it("falls back to the email name when the user has no profile row", async () => {
    harness.profile = null;
    await expect(getAdminContext()).resolves.toMatchObject({ profile: { user_id: "user-a", display_name: "owner" } });
  });

  it("documents the no-factor AAL1 case and enforces enrolled MFA", async () => {
    await expect(getAdminContext()).resolves.toMatchObject({ user: { id: "user-a" }, mfaVerified: false, mfaState: "unenrolled_allowed" });

    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2", currentAuthenticationMethods: [{ method: "password" }] };
    await expect(getAdminContext()).resolves.toBeNull();
    await expect(getAdminContext({ requireMfa: false })).resolves.toMatchObject({ mfaRequired: true, mfaVerified: false, mfaState: "challenge_required" });
  });

  it("restricts an unenrolled member once mandatory MFA is activated", async () => {
    harness.policy = { mandatory_mfa_enabled: true };
    await expect(getAdminContext()).resolves.toBeNull();
    await expect(getAdminContext({ requireMfa: false })).resolves.toMatchObject({ mandatoryMfa: true, mfaState: "enrollment_required" });
  });

  it("fails closed when the mandatory-MFA policy cannot be read", async () => {
    harness.policyError = new Error("policy unavailable");
    await expect(getAdminContext()).resolves.toBeNull();
    await expect(getAdminContext({ requireMfa: false })).resolves.toMatchObject({ mandatoryMfa: true, mfaState: "enrollment_required" });
  });

  it("allows AAL2 but rejects an invalid trusted-device credential", async () => {
    harness.assurance = { currentLevel: "aal2", nextLevel: "aal2", currentAuthenticationMethods: [{ method: "password" }, { method: "totp" }] };
    await expect(getAdminContext()).resolves.toMatchObject({ mfaVerified: true, mfaState: "verified" });

    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2", currentAuthenticationMethods: [{ method: "password" }] };
    harness.cookies.set("af_trusted_device", "malformed");
    await expect(getAdminContext({ allowTrustedDevice: true })).resolves.toBeNull();
  });

  it("accepts a valid remembered device only when that bypass is explicitly enabled", async () => {
    const token = "a".repeat(64);
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2", currentAuthenticationMethods: [{ method: "password" }] };
    harness.cookies.set("af_trusted_device", token);
    harness.trustedRecord = {
      id: "device-id",
      user_id: "user-a",
      token_hash: await hashTrustedDeviceToken(token),
      device_label: "Chrome on Windows",
      user_agent_summary: null,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    };

    await expect(getAdminContext()).resolves.toBeNull();
    await expect(getAdminContext({ allowTrustedDevice: true })).resolves.toMatchObject({
      trustedDevice: { id: "device-id" },
      mfaVerified: false,
      mfaState: "trusted",
    });
  });
});

describe("selectGarage", () => {
  const memberships = [
    { garageId: garageA.id, name: garageA.name, role: "owner" as const },
    { garageId: garageB.id, name: garageB.name, role: "manager" as const },
  ];

  it("accepts only a garage in the membership list, case-insensitively", () => {
    expect(selectGarage(memberships, garageB.id)?.garageId).toBe(garageB.id);
    expect(selectGarage(memberships, garageB.id.toUpperCase())?.garageId).toBe(garageB.id);
    expect(selectGarage(memberships, garageC.id)?.garageId).toBe(garageA.id);
    expect(selectGarage(memberships, undefined)?.garageId).toBe(garageA.id);
    expect(selectGarage([], garageA.id)).toBeNull();
  });
});
