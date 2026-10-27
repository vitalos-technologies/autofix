import { beforeEach, describe, expect, it, vi } from "vitest";

// getAdminContext() during a super-admin impersonation (P4.5): the hint cookie
// only triggers the lookup, current_impersonation() decides; the impersonated
// garage is the only one; server actions and non-GET requests get no context
// (writes blocked, and logged); page views are logged, prefetches are not.

const garageA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Hartley Road Motors", status: "active" };
const garageB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Demo Garage B", status: "active" };

const harness = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  memberships: [] as Array<{ garage_id: string; role: string; created_at: string; garage: { id: string; name: string; status: string } }>,
  session: null as null | Record<string, string>,
  cookies: new Map<string, string>(),
  requestHeaders: new Headers(),
  rpcCalls: [] as Array<[string, unknown]>,
  clientHeaders: [] as Array<Record<string, string>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (harness.cookies.has(name) ? { name, value: harness.cookies.get(name) } : undefined),
    getAll: () => [...harness.cookies].map(([name, value]) => ({ name, value })),
    set: vi.fn(),
  })),
  headers: vi.fn(async () => harness.requestHeaders),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { global?: { headers?: Record<string, string> } }) => {
    const headers = options.global?.headers ?? {};
    harness.clientHeaders.push(headers);
    return {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: harness.user } })),
        mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2", currentAuthenticationMethods: [] }, error: null })) },
      },
      rpc: vi.fn(async (name: string, args?: unknown) => {
        harness.rpcCalls.push([name, args]);
        if (name === "current_impersonation") return { data: harness.session ? [harness.session] : [], error: null };
        return { data: true, error: null };
      }),
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
            if (table === "garages") {
              // Stand-in for RLS + garage_role(): the header's garage when a member or the impersonated garage.
              const id = String(filters.get("id"));
              const impersonated = harness.session?.garage_id === id;
              const member = harness.memberships.some((membership) => membership.garage_id === id);
              const garage = [garageA, garageB].find((candidate) => candidate.id === id);
              return { data: headers["x-garage-id"] === id && (impersonated || member) && garage ? { ...garage, slug: "g", booking_prefix: "HRM", garage_domains: [] } : null, error: null };
            }
            return { data: null, error: null };
          },
          then: (resolve: (value: unknown) => unknown) => {
            const data = table === "garage_members" && harness.user ? harness.memberships : [];
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return query;
      },
    };
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { mandatory_mfa_enabled: false }, error: null }) };
      return query;
    },
  }),
}));

import { IMPERSONATION_COOKIE } from "@/lib/platform/policy";
import { getAdminContext } from "@/lib/tenancy/admin";
import { REQUEST_METHOD_HEADER, REQUEST_PATH_HEADER } from "@/lib/tenancy/request-headers";

function openSession(garage = garageB, minutesLeft = 20) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    garage_id: garage.id,
    garage_name: garage.name,
    reason: "Support ticket 42",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + minutesLeft * 60_000).toISOString(),
  };
}

function get(path = "/app/customers") {
  return new Headers({ [REQUEST_METHOD_HEADER]: "GET", [REQUEST_PATH_HEADER]: path });
}

const rpcNames = () => harness.rpcCalls.map(([name]) => name);

describe("getAdminContext with an impersonation", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    harness.user = { id: "platform-admin", email: "support@vitalos.co.uk" };
    harness.memberships = [{ garage_id: garageA.id, role: "technician", created_at: "2026-10-01T09:00:00Z", garage: garageA }];
    harness.session = openSession();
    harness.cookies = new Map([[IMPERSONATION_COOKIE, "1"]]);
    harness.requestHeaders = get();
    harness.rpcCalls = [];
    harness.clientHeaders = [];
  });

  it("resolves the impersonated garage, read as owner, as the only garage, and logs the page view", async () => {
    const context = await getAdminContext();
    expect(context).toMatchObject({
      garage: { id: garageB.id, name: garageB.name },
      role: "owner",
      memberships: [{ garageId: garageB.id, name: garageB.name, role: "owner" }],
      impersonation: { garageId: garageB.id, garageName: garageB.name, reason: "Support ticket 42" },
    });
    expect(harness.clientHeaders).toContainEqual({ "x-garage-id": garageB.id });
    expect(harness.rpcCalls).toContainEqual(["log_impersonation_event", { p_action: "platform.impersonation_page_view", p_path: "/app/customers" }]);
  });

  it("ignores the af_garage cookie while impersonating", async () => {
    harness.cookies.set("af_garage", garageA.id);
    expect((await getAdminContext())?.garage.id).toBe(garageB.id);
  });

  it("refuses server actions and logs the blocked write", async () => {
    harness.requestHeaders = new Headers({ [REQUEST_METHOD_HEADER]: "POST", [REQUEST_PATH_HEADER]: "/app/customers", "next-action": "abc123" });
    await expect(getAdminContext()).resolves.toBeNull();
    await expect(getAdminContext({ requireMfa: false, allowTrustedDevice: true })).resolves.toBeNull();
    expect(harness.rpcCalls).toContainEqual(["log_impersonation_event", { p_action: "platform.impersonation_write_blocked", p_path: "/app/customers" }]);
    expect(harness.clientHeaders).not.toContainEqual({ "x-garage-id": garageB.id });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses %s route requests", async (method) => {
    harness.requestHeaders = new Headers({ [REQUEST_METHOD_HEADER]: method });
    await expect(getAdminContext()).resolves.toBeNull();
  });

  it("fails closed when the proxy's method header is missing", async () => {
    harness.requestHeaders = new Headers();
    await expect(getAdminContext()).resolves.toBeNull();
  });

  it("does not log router prefetches as page views", async () => {
    harness.requestHeaders = get();
    harness.requestHeaders.set("next-router-prefetch", "1");
    expect((await getAdminContext())?.garage.id).toBe(garageB.id);
    expect(rpcNames()).not.toContain("log_impersonation_event");
  });

  it("falls back to the user's own garages when the session has expired or ended", async () => {
    harness.session = openSession(garageB, -1);
    const expired = await getAdminContext();
    expect(expired).toMatchObject({ garage: { id: garageA.id }, role: "technician", impersonation: null });
    harness.session = null;
    expect((await getAdminContext())?.garage.id).toBe(garageA.id);
    expect(rpcNames()).not.toContain("log_impersonation_event");
  });

  it("never looks for a session without the hint cookie", async () => {
    harness.cookies = new Map();
    expect((await getAdminContext())?.garage.id).toBe(garageA.id);
    expect(rpcNames()).not.toContain("current_impersonation");
  });

  it("gives an impersonating admin with no garage of their own a context only for reads", async () => {
    harness.memberships = [];
    expect((await getAdminContext())?.garage.id).toBe(garageB.id);
    harness.session = null;
    await expect(getAdminContext()).resolves.toBeNull();
  });
});
