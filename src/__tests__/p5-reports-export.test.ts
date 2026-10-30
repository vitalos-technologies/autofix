import { beforeEach, describe, expect, it, vi } from "vitest";
import { testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({
  admin: null as Record<string, unknown> | null,
  rpc: vi.fn(),
  recordAdminAudit: vi.fn(async () => true),
}));

vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: vi.fn(async () => harness.admin) }));
vi.mock("@/lib/admin/audit", () => ({ recordAdminAudit: harness.recordAdminAudit }));

import { GET } from "@/app/api/admin/reports/[report]/route";

const pro = testGarage({ plan: "pro", planChosen: "pro", trialEndsAt: null } as never);
const essentials = testGarage({ plan: "essentials", planChosen: "essentials", trialEndsAt: null } as never);

function adminFor(garage: ReturnType<typeof testGarage>, role = "owner") {
  return { garage, role, user: { id: "user-1" }, client: { rpc: harness.rpc } };
}

function get(kind: string, query = "range=last_month") {
  return GET(new Request(`https://pitline.co.uk/api/admin/reports/${kind}?${query}`), { params: Promise.resolve({ report: kind }) });
}

describe("P5.6 report CSV export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.admin = null;
    harness.rpc.mockResolvedValue({
      data: [{ service_id: "s1", service_name: "@evil", bookings: 1, invoiced_pence: 0, estimated_pence: 4500, total_pence: 4500 }],
      error: null,
    });
  });

  it("401 when signed out, without touching the database", async () => {
    const response = await get("revenue-by-service");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("404 for an unknown report", async () => {
    harness.admin = adminFor(pro);
    expect((await get("customers")).status).toBe(404);
  });

  it("403 PLAN_REQUIRED for an Essentials garage", async () => {
    harness.admin = adminFor(essentials);
    const response = await get("revenue-by-service");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PLAN_REQUIRED", feature: "advanced_reports", plan: "pro" });
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("403 for technicians and front desk", async () => {
    for (const role of ["technician", "front_desk"]) {
      harness.admin = adminFor(pro, role);
      const response = await get("hours");
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "NOT_ALLOWED" });
    }
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it("400 for a bad range", async () => {
    harness.admin = adminFor(pro);
    const response = await get("hours", "range=custom&from=2026-10-10&to=2026-10-01");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_RANGE" });
  });

  it("streams an injection-safe CSV attachment through the RLS client, with only dates in the name", async () => {
    harness.admin = adminFor(pro, "manager");
    const response = await get("revenue-by-service", "range=custom&from=2026-10-01&to=2026-10-31");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="pitline-revenue-by-service-2026-10-01-to-2026-10-31.csv"');
    expect(response.headers.get("cache-control")).toContain("private");
    expect(harness.rpc).toHaveBeenCalledWith("report_revenue_by_service", { p_from: "2026-10-01", p_to: "2026-10-31" });
    const body = await response.text();
    expect(body).toContain(`"'@evil",1,0,45,45`);
    expect(harness.recordAdminAudit).toHaveBeenCalledWith(pro.id, expect.objectContaining({ action: "report.exported", entityId: "revenue-by-service" }));
  });

  it("maps a database PLAN_REQUIRED (plan changed mid-session) to the 403", async () => {
    harness.admin = adminFor(pro);
    harness.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "PLAN_REQUIRED: advanced_reports" } });
    const response = await get("bay-utilisation");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PLAN_REQUIRED" });
  });

  it("reminder return asks for campaigns too and leaves them out when not installed", async () => {
    harness.admin = adminFor(pro);
    harness.rpc.mockImplementation(async (name: string) =>
      name === "report_campaign_roi"
        ? { data: [{ available: false, sent: 0, booked: 0, pence: 0 }], error: null }
        : { data: [{ kind: "mot", sent: 4, booked: 1, pence: 6000, sms_segments: 4 }], error: null },
    );
    const response = await get("reminder-roi");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"MOT reminders",4,1,60,4');
    expect(body).not.toContain("Campaigns");
  });
});
