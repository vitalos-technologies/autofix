import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { otherTestGarage, testGarage } from "./support/garage";

// Admin and platform server paths: the garage switcher only accepts the
// user's own garages, audit rows always carry a garage_id, the retention cron
// runs once per garage, health leaks nothing, and admin pages stay on the
// RLS garage client.

const garage = testGarage();
const other = otherTestGarage();

const harness = vi.hoisted(() => ({
  context: null as null | Record<string, unknown>,
  cookieSets: [] as Array<[string, string, Record<string, unknown>]>,
  revalidated: [] as Array<[string, string | undefined]>,
  admin: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (name: string, value: string, options: Record<string, unknown>) => harness.cookieSets.push([name, value, options]) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string, type?: string) => harness.revalidated.push([path, type]) }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/tenancy/admin", () => ({
  GARAGE_COOKIE: "af_garage",
  GARAGE_COOKIE_OPTIONS: { httpOnly: true, sameSite: "lax", path: "/" },
  getAdminContext: vi.fn(async () => harness.context),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => harness.admin }));
vi.mock("@/lib/env", () => ({
  getEnvironmentReadiness: () => ({ ready: true, missing: [] }),
  getBookingEnvironmentReadiness: () => ({ ready: true, missing: [] }),
}));

import { GET as healthRoute } from "@/app/api/health/route";
import { GET as retentionRoute } from "@/app/api/cron/retention/route";
import { recordAdminAudit, recordUserSecurityEvent } from "@/lib/admin/audit";
import { getAdminNotificationSummary } from "@/lib/admin/notifications";
import { switchGarage } from "@/lib/tenancy/switch-garage";

function memberContext(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    garage,
    role: "owner",
    memberships: [
      { garageId: garage.id, name: garage.name, role: "owner" },
      { garageId: other.id, name: other.name, role: "staff" },
    ],
    mfaState: "verified",
    ...overrides,
  };
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("switchGarage", () => {
  beforeEach(() => {
    harness.context = memberContext();
    harness.cookieSets = [];
    harness.revalidated = [];
  });

  it("sets the httpOnly af_garage cookie for one of the user's garages and reloads the admin", async () => {
    await expect(switchGarage(form({ garageId: other.id.toUpperCase() }))).rejects.toThrow("REDIRECT:/app");
    expect(harness.cookieSets).toEqual([["af_garage", other.id, expect.objectContaining({ httpOnly: true, path: "/" })]]);
    expect(harness.revalidated).toEqual([["/app", "layout"]]);
  });

  it("ignores a garage the user does not belong to, or a malformed id", async () => {
    for (const garageId of ["3333aaaa-3333-4333-8333-333333333333", "not-a-uuid", ""]) {
      await expect(switchGarage(form({ garageId }))).resolves.toBeUndefined();
    }
    await expect(switchGarage(new FormData())).resolves.toBeUndefined();
    expect(harness.cookieSets).toHaveLength(0);
    expect(harness.revalidated).toHaveLength(0);
  });

  it("sends signed-out users to login and unverified users to MFA before touching the cookie", async () => {
    harness.context = null;
    await expect(switchGarage(form({ garageId: other.id }))).rejects.toThrow("REDIRECT:/app/login");
    harness.context = memberContext({ mfaState: "challenge_required" });
    await expect(switchGarage(form({ garageId: other.id }))).rejects.toThrow("REDIRECT:/app/mfa");
    harness.context = memberContext({ mfaState: "enrollment_required" });
    await expect(switchGarage(form({ garageId: other.id }))).rejects.toThrow("REDIRECT:/app/mfa/enroll");
    expect(harness.cookieSets).toHaveLength(0);
  });
});

describe("admin audit rows", () => {
  function recordingClient(memberGarageIds: string[]) {
    const inserts: unknown[] = [];
    const selects: Array<[string, string, unknown]> = [];
    const client = {
      from: (table: string) => ({
        insert: async (payload: unknown) => {
          inserts.push(payload);
          return { error: null };
        },
        select: () => ({
          eq: async (field: string, value: unknown) => {
            selects.push([table, field, value]);
            return { data: memberGarageIds.map((garage_id) => ({ garage_id })), error: null };
          },
        }),
      }),
    };
    return { client, inserts, selects };
  }

  it("writes garage_id on every admin audit entry", async () => {
    const { client, inserts } = recordingClient([]);
    await expect(recordAdminAudit(garage.id, { actorId: "actor", action: "booking.cancelled", entityType: "booking", entityId: "booking-id" }, client as never)).resolves.toBe(true);
    expect(inserts).toEqual([expect.objectContaining({ garage_id: garage.id, action: "booking.cancelled", detail: {} })]);
  });

  it("copies account security events to each of the user's garages, and to none without a membership", async () => {
    const multi = recordingClient([garage.id, other.id, garage.id]);
    await recordUserSecurityEvent("user-id", "mfa_enrolled", { factor: "totp" }, {}, multi.client as never);
    expect(multi.selects).toEqual([["garage_members", "user_id", "user-id"]]);
    expect(multi.inserts).toEqual([[
      expect.objectContaining({ garage_id: garage.id, actor_id: "user-id", action: "mfa_enrolled", entity_type: "admin_security" }),
      expect.objectContaining({ garage_id: other.id, actor_id: "user-id", action: "mfa_enrolled" }),
    ]]);

    const none = recordingClient([]);
    await expect(recordUserSecurityEvent("user-id", "password_changed", {}, {}, none.client as never)).resolves.toBe(true);
    expect(none.inserts).toHaveLength(0);
  });
});

describe("retention cron", () => {
  const rpc = vi.fn();
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron-secret-value");
    rpc.mockReset();
    harness.admin = {
      from: (table: string) => ({
        select: () => ({ order: async () => ({ data: table === "garages" ? [{ id: garage.id }, { id: other.id }] : [], error: null }) }),
      }),
      rpc,
    };
  });
  afterEach(() => vi.unstubAllEnvs());

  const cronRequest = (authorization?: string) => new NextRequest("https://autofix.vitalos.co.uk/api/cron/retention", { headers: authorization ? { authorization } : {} });

  it("rejects calls without the cron secret", async () => {
    expect((await retentionRoute(cronRequest())).status).toBe(401);
    expect((await retentionRoute(cronRequest("Bearer wrong"))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("runs apply_enquiry_retention once per garage and returns totals only", async () => {
    rpc.mockResolvedValueOnce({ data: 2, error: null }).mockResolvedValueOnce({ data: 3, error: null });
    const response = await retentionRoute(cronRequest("Bearer cron-secret-value"));
    expect(response.status).toBe(200);
    expect(rpc.mock.calls).toEqual([
      ["apply_enquiry_retention", { p_garage_id: garage.id }],
      ["apply_enquiry_retention", { p_garage_id: other.id }],
    ]);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ success: true, processedGarages: 2, anonymisedRecords: 5 });
    expect(body).not.toContain(garage.id);
  });

  it("keeps going past a failing garage and reports a 500 without naming it", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: `garage ${garage.id} failed` } }).mockResolvedValueOnce({ data: 1, error: null });
    const response = await retentionRoute(cronRequest("Bearer cron-secret-value"));
    expect(response.status).toBe(500);
    expect(rpc).toHaveBeenCalledTimes(2);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ processedGarages: 1, failedGarages: 1, anonymisedRecords: 1 });
    expect(body).not.toContain(garage.id);
  });
});

describe("health route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports tenancy readiness as statuses only, never garage data", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable");
    harness.admin = { from: () => ({ select: () => ({ limit: async () => ({ data: [{ id: garage.id, name: garage.name, slug: garage.slug }], error: null }) }) }) };
    const response = await healthRoute();
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body).checks.tenancy).toEqual({ supabase: "configured", garages: "ready", status: "ready" });
    for (const secret of [garage.id, garage.name, garage.slug, "publishable", "127.0.0.1"]) expect(body).not.toContain(secret);
  });

  it("is not ready without a database or without any garage", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable");
    harness.admin = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }) };
    const empty = await healthRoute();
    expect(empty.status).toBe(503);
    expect((await empty.json()).checks.tenancy.garages).toBe("none");

    harness.admin = null;
    const offline = await healthRoute();
    expect(offline.status).toBe(503);
    expect((await offline.json()).checks.tenancy).toEqual({ supabase: "configuration_required", garages: "none", status: "configuration_required" });
  });
});

describe("admin pages stay on the garage's RLS client", () => {
  const root = process.cwd();
  const files = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });

  it("uses the service role in protected admin code only where the database requires it", () => {
    const serviceRoleFiles = files(join(root, "src/app/app/(protected)"))
      .filter((path) => readFileSync(path, "utf8").includes("createAdminClient("))
      .map((path) => relative(root, path))
      .sort();
    // Security settings manage MFA factors and trusted devices (auth schema);
    // bookings/actions.ts calls the service-only create_booking_enquiry_thread
    // RPC with the context garage's p_garage_id.
    expect(serviceRoleFiles).toEqual([
      "src/app/app/(protected)/bookings/actions.ts",
      "src/app/app/(protected)/configuration/security/actions.ts",
      "src/app/app/(protected)/configuration/security/page.tsx",
    ]);
    expect(readFileSync(join(root, "src/app/app/(protected)/bookings/actions.ts"), "utf8")).toContain("p_garage_id: admin.garage.id");
  });

  it("never reads a garage id from a form, query string or request body", () => {
    const pattern = /(formData|searchParams|params|body|input)\??\.(get\(\s*["']garage_?[iI]d["']|garage_?[iI]d\b)/;
    // Routes, pages and every server action ("use server" files in src/lib).
    // Internal library inputs such as getAvailableSlots({ garageId }) are
    // filled from the host or admin context by these callers.
    const serverActions = files(join(root, "src/lib")).filter((path) => /^["']use server["']/.test(readFileSync(path, "utf8")));
    const scanned = [...files(join(root, "src/app")), ...serverActions];
    for (const route of ["src/app/api/bookings/route.ts", "src/app/api/bookings/manage/route.ts", "src/app/api/slots/route.ts", "src/app/api/services/route.ts"]) {
      expect(scanned.map((path) => relative(root, path))).toContain(route);
    }
    // The super admin (P4.5, DECISIONS A126) names the garage it acts on by design; the database checks
    // platform_admins and AAL2 for every one of those calls. Nothing there selects a tenant context.
    const platformTargets = ["src/app/api/platform/", "src/app/admin/", "src/lib/platform/"];
    const offenders = scanned
      .filter((path) => !path.endsWith("switch-garage.ts"))
      .filter((path) => !platformTargets.some((prefix) => relative(root, path).startsWith(prefix)))
      .filter((path) => pattern.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });

  it("counts notifications through the client it is given", async () => {
    const tables: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "is", "or", "gt", "eq", "in"]) builder[method] = () => builder;
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    const client = { from: (table: string) => { tables.push(table); return builder; } };
    harness.admin = { from: () => { throw new Error("service role must not be used"); } };
    await expect(getAdminNotificationSummary(client as never)).resolves.toEqual({ count: 0, enquiryCount: 0, bookingCount: 0 });
    expect(tables.sort()).toEqual(["booking_notification_events", "bookings", "enquiries", "enquiry_conversations", "enquiry_messages"]);
  });
});
