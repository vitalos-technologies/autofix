import { beforeEach, describe, expect, it, vi } from "vitest";

// Onboarding step 4 (P4.4): MOT on/off and which seeded services to keep. Changed services are saved
// with one update per direction (restore, archive), not one round trip per service.

type Call = { table: string; op: "select" | "update"; values?: Record<string, unknown>; filters: Array<[string, string, unknown]> };

const harness = vi.hoisted(() => ({
  calls: [] as Call[],
  services: [] as Array<{ id: string; is_mot: boolean; deleted_at: string | null }>,
  failUpdates: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/settings/server", () => ({ afterSetupChange: vi.fn(), auditSetupChange: vi.fn(async () => undefined) }));
vi.mock("@/app/app/onboarding/context", () => ({
  requireOnboardingOwner: vi.fn(async () => ({
    user: { id: "user-1" },
    garage: { id: "garage-1" },
    client: {
      from: (table: string) => {
        const call: Call = { table, op: "select", filters: [] };
        harness.calls.push(call);
        const query = {
          select: () => query,
          update: (values: Record<string, unknown>) => {
            call.op = "update";
            call.values = values;
            return query;
          },
          eq: (column: string, value: unknown) => {
            call.filters.push(["eq", column, value]);
            return query;
          },
          in: (column: string, value: unknown) => {
            call.filters.push(["in", column, value]);
            return query;
          },
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
            const result = call.op === "select"
              ? { data: harness.services, error: null }
              : { data: null, error: harness.failUpdates && table === "services" ? { message: "failed" } : null };
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return query;
      },
    },
  })),
}));

import { saveOnboardingServicesAction } from "@/app/app/onboarding/actions";

function form(mot: "yes" | "no", keep: string[]) {
  const data = new FormData();
  data.set("mot", mot);
  for (const id of keep) data.append("service", id);
  return data;
}

describe("saveOnboardingServicesAction", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.failUpdates = false;
    harness.services = [
      { id: "mot", is_mot: true, deleted_at: "2026-10-29T09:00:00.000Z" },
      { id: "oil", is_mot: false, deleted_at: null },
      { id: "brakes", is_mot: false, deleted_at: null },
      { id: "tyres", is_mot: false, deleted_at: "2026-10-29T09:00:00.000Z" },
      { id: "diagnostics", is_mot: false, deleted_at: null },
    ];
  });

  it("saves MOT first, then restores and archives services in one update each", async () => {
    await expect(saveOnboardingServicesAction(form("yes", ["oil", "tyres", "diagnostics"]))).rejects.toThrow("REDIRECT:/app/onboarding/agreement");
    const updates = harness.calls.filter((call) => call.op === "update");
    expect(updates[0]).toMatchObject({ table: "garages", values: { mot_enabled: true }, filters: [["eq", "id", "garage-1"]] });
    expect(updates.slice(1)).toHaveLength(2);
    expect(updates[1]).toEqual({
      table: "services",
      op: "update",
      values: { deleted_at: null, deleted_by: null },
      filters: [["eq", "garage_id", "garage-1"], ["in", "id", ["mot", "tyres"]]],
    });
    expect(updates[2]).toMatchObject({
      table: "services",
      values: { deleted_by: "user-1", deleted_at: expect.any(String) },
      filters: [["eq", "garage_id", "garage-1"], ["in", "id", ["brakes"]]],
    });
  });

  it("archives the MOT service with MOT off, and sends nothing for services that did not change", async () => {
    harness.services[0]!.deleted_at = null;
    await expect(saveOnboardingServicesAction(form("no", ["oil", "brakes", "diagnostics"]))).rejects.toThrow("REDIRECT:/app/onboarding/agreement");
    const serviceUpdates = harness.calls.filter((call) => call.op === "update" && call.table === "services");
    expect(serviceUpdates).toHaveLength(1);
    expect(serviceUpdates[0]!.filters).toEqual([["eq", "garage_id", "garage-1"], ["in", "id", ["mot"]]]);
    expect(serviceUpdates[0]!.values).toMatchObject({ deleted_by: "user-1" });
  });

  it("refuses to keep no services, and reports a failed save", async () => {
    await expect(saveOnboardingServicesAction(form("yes", []))).rejects.toThrow("REDIRECT:/app/onboarding/services?error=none_kept");
    harness.failUpdates = true;
    await expect(saveOnboardingServicesAction(form("yes", ["oil"]))).rejects.toThrow("REDIRECT:/app/onboarding/services?error=save_failed");
  });
});
