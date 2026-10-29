import { beforeEach, describe, expect, it, vi } from "vitest";
import { testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({
  admin: null as Record<string, unknown> | null,
  getAdminContext: vi.fn(),
  recordAdminAudit: vi.fn(async () => true),
  loadSubscription: vi.fn(async () => null as null | { subscription_ref: string | null }),
  serviceRpc: vi.fn(async () => ({ data: 1, error: null }) as { data: unknown; error: unknown }),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: harness.getAdminContext }));
vi.mock("@/lib/admin/audit", () => ({ recordAdminAudit: harness.recordAdminAudit }));
vi.mock("@/lib/billing/server", () => ({ loadSubscription: harness.loadSubscription }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({ rpc: harness.serviceRpc }), createClient: vi.fn() }));
vi.mock("@/lib/tenancy/resolve", () => ({ clearHostCache: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: harness.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: harness.redirect }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { GET as groupReport } from "@/app/api/admin/group/report/route";
import { addSiteAction, removeSiteAction } from "@/lib/group/actions";
import { syncExtraSites } from "@/lib/group/server";
import type { BillingProvider } from "@/lib/billing";

const PRO = { plan: "pro", trialEndsAt: null, planChosen: "pro" } as const;
const ESSENTIALS = { plan: "essentials", trialEndsAt: null, planChosen: "essentials" } as const;
const HOME_ID = "33333333-3333-4333-8333-333333333333";
const FORGED_ID = "44444444-4444-4444-8444-444444444444";

function rlsClient(rpc: (name: string, args?: unknown) => Promise<{ data: unknown; error: unknown }>) {
  return { rpc: vi.fn(rpc), tag: "rls-garage-client" };
}

function adminWith(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "owner-id", email: "owner@example.test" },
    role: "owner",
    mfaVerified: true,
    garage: testGarage(PRO),
    client: rlsClient(async () => ({ data: [], error: null })),
    ...overrides,
  };
}

function siteForm(fields: Record<string, string> = {}) {
  const form = new FormData();
  const values = { name: "Hartley North", phone: "01302 123456", line1: "1 North Street", town: "Doncaster", postcode: "DN1 1AA", slug: "hartley-north", ...fields };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.admin = null;
  harness.getAdminContext.mockImplementation(async () => harness.admin);
  harness.serviceRpc.mockImplementation(async () => ({ data: 1, error: null }));
});

describe("GET /api/admin/group/report", () => {
  const url = "https://pitline.co.uk/api/admin/group/report?from=2026-10-01&to=2026-10-28";

  it("is 401 signed out", async () => {
    const response = await groupReport(new Request(url));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("is 403 for technicians", async () => {
    harness.admin = adminWith({ role: "technician" });
    expect((await groupReport(new Request(url))).status).toBe(403);
  });

  it("is 403 PLAN_REQUIRED for an Essentials garage, before reading anything", async () => {
    const admin = adminWith({ garage: testGarage(ESSENTIALS) });
    harness.admin = admin;
    const response = await groupReport(new Request(url));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PLAN_REQUIRED", feature: "multi_site", plan: "pro" });
    expect((admin.client as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("exports a private CSV through the member's RLS client only", async () => {
    const admin = adminWith({
      client: rlsClient(async () => ({ data: [{ garage_id: HOME_ID, name: "Hartley Road", is_home: true, bookings: 2, revenue_pence: 4500 }], error: null })),
    });
    harness.admin = admin;
    const response = await groupReport(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="Group-report-2026-10-01-to-2026-10-28.csv"');
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toContain('"Hartley Road","2026-10-01","2026-10-28","2","45.00"');
    expect((admin.client as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith("group_report", { p_from: "2026-10-01", p_to: "2026-10-28" });
    expect(harness.serviceRpc).not.toHaveBeenCalled();
    expect(harness.recordAdminAudit).toHaveBeenCalledWith(testGarage().id, expect.objectContaining({ action: "group.report_exported" }));
  });

  it("maps a database PLAN_REQUIRED (home garage downgraded) to the 403", async () => {
    harness.admin = adminWith({ client: rlsClient(async () => ({ data: null, error: { code: "P0001", message: "PLAN_REQUIRED: multi_site" } })) });
    const response = await groupReport(new Request(url));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PLAN_REQUIRED" });
  });
});

describe("addSiteAction", () => {
  const initial = { seq: 0, errors: {} };

  it("returns field errors before touching the database", async () => {
    harness.admin = adminWith();
    const state = await addSiteAction(initial, siteForm({ name: "", slug: "X!" }));
    expect(state.errors.name).toBeTruthy();
    expect(state.errors.slug).toBeTruthy();
    expect(harness.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses managers and unverified owners", async () => {
    harness.admin = adminWith({ role: "manager" });
    expect((await addSiteAction(initial, siteForm())).message).toMatch(/owner/i);
    harness.admin = adminWith({ mfaVerified: false });
    expect((await addSiteAction(initial, siteForm())).message).toMatch(/verify/i);
  });

  it("refuses an Essentials garage with the plan message (no rpc)", async () => {
    const admin = adminWith({ garage: testGarage(ESSENTIALS) });
    harness.admin = admin;
    const state = await addSiteAction(initial, siteForm());
    expect(state.message).toMatch(/Pro/);
    expect((admin.client as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("creates the site through group_add_site() and bills the home garage the database names, not the form", async () => {
    const admin = adminWith({
      client: rlsClient(async () => ({ data: { garage_id: "new-id", slug: "hartley-north", home_garage_id: HOME_ID, site_count: 2, extra_sites: 1 }, error: null })),
    });
    harness.admin = admin;
    const state = await addSiteAction(initial, siteForm({ garageId: FORGED_ID, homeGarageId: FORGED_ID }));
    expect(state.added).toEqual({ name: "Hartley North", slug: "hartley-north", extraSites: 1, billingRecorded: true });
    const rpc = (admin.client as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpc).toHaveBeenCalledWith("group_add_site", { p_garage: expect.objectContaining({ name: "Hartley North", slug: "hartley-north", phone: "+441302123456" }) });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(FORGED_ID);
    expect(harness.loadSubscription).toHaveBeenCalledWith(HOME_ID);
    expect(harness.serviceRpc).toHaveBeenCalledWith("record_group_extra_sites", { p_home_garage_id: HOME_ID, p_provider: "mock" });
  });

  it("maps a taken booking link to the slug field", async () => {
    harness.admin = adminWith({ client: rlsClient(async () => ({ data: null, error: { code: "P0001", message: "SLUG_TAKEN" } })) });
    const state = await addSiteAction(initial, siteForm());
    expect(state.errors.slug).toMatch(/already uses/);
  });
});

describe("removeSiteAction", () => {
  it("asks for confirmation first", async () => {
    harness.admin = adminWith();
    const form = new FormData();
    form.set("siteId", HOME_ID);
    await expect(removeSiteAction(form)).rejects.toThrow(`REDIRECT /app/group?confirm=${HOME_ID}#sites`);
  });

  it("removes through group_remove_site() and lowers the recorded count", async () => {
    const admin = adminWith({ client: rlsClient(async () => ({ data: { home_garage_id: HOME_ID, site_count: 1, extra_sites: 0 }, error: null })) });
    harness.admin = admin;
    harness.serviceRpc.mockImplementation(async () => ({ data: 0, error: null }));
    const form = new FormData();
    form.set("siteId", FORGED_ID);
    form.set("confirm", "yes");
    await expect(removeSiteAction(form)).rejects.toThrow("REDIRECT /app/group?done=site_removed");
    expect((admin.client as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith("group_remove_site", { p_site_garage_id: FORGED_ID });
    expect(harness.serviceRpc).toHaveBeenCalledWith("record_group_extra_sites", { p_home_garage_id: HOME_ID, p_provider: "mock" });
  });
});

describe("syncExtraSites", () => {
  it("does not record when the provider refuses, and audits it", async () => {
    const provider = { kind: "stripe", setExtraSites: vi.fn(async () => ({ ok: false, code: "provider_error" })) } as unknown as BillingProvider;
    harness.loadSubscription.mockResolvedValueOnce({ subscription_ref: "sub_test" });
    const result = await syncExtraSites({ homeGarageId: HOME_ID, extraSites: 2, actorId: "owner-id" }, provider);
    expect(result).toEqual({ ok: false, extraSites: 2 });
    expect(provider.setExtraSites).toHaveBeenCalledWith({ garageId: HOME_ID, subscriptionRef: "sub_test", count: 2 });
    expect(harness.serviceRpc).not.toHaveBeenCalled();
    expect(harness.recordAdminAudit).toHaveBeenCalledWith(HOME_ID, expect.objectContaining({ action: "group.billing_failed" }));
  });
});
