import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "./support/fake-supabase";
import { testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({
  admin: null as null | { role: string; garage: unknown; user: { id: string; email: string }; profile: { display_name: string } },
  service: null as unknown,
  refreshes: 0,
}));
vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: async () => harness.admin }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => harness.service }));
vi.mock("next/cache", () => ({ refresh: () => (harness.refreshes += 1) }));

const { acceptDpaAction } = await import("@/lib/legal/agreement-actions");
const { initialAcceptAgreementState } = await import("@/lib/legal/agreement-forms");
const { DPA_VERSION, dpaTextHash } = await import("@/lib/legal/documents");

const garage = testGarage();
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("acceptDpaAction", () => {
  let fake: ReturnType<typeof createFakeSupabase>;
  beforeEach(() => {
    fake = createFakeSupabase({ rpc: () => ({ data: { id: "x" }, error: null }) });
    harness.service = fake.client;
    harness.admin = { role: "owner", garage, user: { id: OWNER, email: "owner@example.test" }, profile: { display_name: "Ann Owner" } };
    harness.refreshes = 0;
  });

  it("records the owner's acceptance with the server's version and text hash", async () => {
    const state = await acceptDpaAction(initialAcceptAgreementState, form({ version: DPA_VERSION, confirm: "yes" }));
    expect(state).toEqual({ status: "accepted", seq: 1 });
    expect(fake.rpcs).toEqual([{
      fn: "accept_garage_agreement",
      args: { p_garage_id: garage.id, p_user_id: OWNER, p_kind: "dpa", p_version: DPA_VERSION, p_text_hash: dpaTextHash(garage), p_accepted_by_name: "Ann Owner" },
    }]);
    expect(harness.refreshes).toBe(1);
  });

  it("refuses managers, unticked confirmations and stale versions without writing", async () => {
    harness.admin = { ...harness.admin!, role: "manager" };
    expect((await acceptDpaAction(initialAcceptAgreementState, form({ version: DPA_VERSION, confirm: "yes" }))).status).toBe("forbidden");
    harness.admin = { ...harness.admin!, role: "owner" };
    expect((await acceptDpaAction(initialAcceptAgreementState, form({ version: DPA_VERSION }))).status).toBe("unconfirmed");
    expect((await acceptDpaAction(initialAcceptAgreementState, form({ version: "0.0", confirm: "yes" }))).status).toBe("stale");
    harness.admin = null;
    expect((await acceptDpaAction(initialAcceptAgreementState, form({ version: DPA_VERSION, confirm: "yes" }))).status).toBe("forbidden");
    expect(fake.rpcs).toEqual([]);
  });

  it("maps the database's owner check to forbidden", async () => {
    harness.service = createFakeSupabase({ rpc: () => ({ data: null, error: { message: "AGREEMENT_FORBIDDEN: only a garage owner can accept agreements" } }) }).client;
    expect((await acceptDpaAction(initialAcceptAgreementState, form({ version: DPA_VERSION, confirm: "yes" }))).status).toBe("forbidden");
  });
});
