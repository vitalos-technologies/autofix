import { beforeEach, describe, expect, it, vi } from "vitest";
import { otherTestGarage, testGarage } from "./support/garage";

// Customers & cars server actions (P3.11): every read and write goes through
// the selected garage's RLS client from getAdminContext(); no garage id is
// ever taken from the request or passed to the database by the app.

const garage = testGarage();
const other = otherTestGarage();

type Call = { kind: "rpc"; name: string; args: Record<string, unknown> } | { kind: "from"; table: string; ops: Array<[string, unknown[]]> };

function fakeClient() {
  const calls: Call[] = [];
  let importCounter = 0;
  const rpcResults: Record<string, (args: Record<string, unknown>) => { data: unknown; error: null | { code: string; message: string } }> = {
    start_customer_import: () => ({ data: `00000000-0000-4000-8000-00000000000${++importCounter}`, error: null }),
    import_customer_rows: (args) => {
      const rows = args.p_rows as Array<{ phone: string; consent: boolean }>;
      return {
        data: {
          customers_created: new Set(rows.map((row) => row.phone)).size,
          customers_updated: 0,
          vehicles_created: 0,
          vehicles_updated: 0,
          consent_recorded: rows.filter((row) => row.consent).length,
        },
        error: null,
      };
    },
    finish_customer_import: () => ({ data: { status: "completed" }, error: null }),
  };
  const client = {
    calls,
    rpcResults,
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ kind: "rpc", name, args });
      return rpcResults[name]!(args);
    }),
    from: vi.fn((table: string) => {
      const call: Call = { kind: "from", table, ops: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "update", "eq", "is", "or", "order", "range", "ilike", "not", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => void) =>
        resolve(table === "customers" && call.ops.some(([op]) => op === "update")
          ? { data: [{ id: "c1" }], error: null }
          : { data: [], error: null, count: 0 });
      return builder;
    }),
  };
  return client;
}

const harness = vi.hoisted(() => ({
  context: null as null | Record<string, unknown>,
  audits: [] as Array<[string, Record<string, unknown>]>,
  afterCallbacks: [] as Array<() => unknown>,
  enrich: vi.fn(async () => ({ checked: 0, enriched: 0, notFound: 0, failed: 0, remaining: false, stoppedReason: "done" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/server", () => ({ after: (callback: () => unknown) => harness.afterCallbacks.push(callback) }));
vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: vi.fn(async () => harness.context) }));
vi.mock("@/lib/admin/audit", () => ({
  recordAdminAudit: vi.fn(async (garageId: string, entry: Record<string, unknown>) => {
    harness.audits.push([garageId, entry]);
    return true;
  }),
}));
vi.mock("@/lib/customers/enrichment", () => ({ enrichImportedVehicles: harness.enrich }));

import {
  importCustomersAction,
  optOutCustomerAction,
  previewCustomerImportAction,
  searchCustomersAction,
} from "@/app/app/(protected)/customers/actions";

function context(role = "manager", overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    garage,
    role,
    memberships: [{ garageId: garage.id, name: garage.name, role }, { garageId: other.id, name: other.name, role: "owner" }],
    client: fakeClient(),
    mfaState: "verified",
    mfaRequired: false,
    mfaVerified: true,
    ...overrides,
  };
}

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => `Customer ${index},07700 9${String(index).padStart(5, "0")},,,yes`);
}

const csv = ["Name,Mobile,Email,Registration,Consent", "Sam Driver,07700 900123,sam@example.com,AB12 CDE,yes", "Bad,01302 123456,,,yes"].join("\n");

function clientOf() {
  return (harness.context as { client: ReturnType<typeof fakeClient> }).client;
}

beforeEach(() => {
  harness.context = context();
  harness.audits = [];
  harness.afterCallbacks = [];
  harness.enrich.mockClear();
});

describe("previewCustomerImportAction", () => {
  it("validates without writing anything", async () => {
    const preview = await previewCustomerImportAction({ fileName: "customers.csv", csv });
    expect(preview).toMatchObject({ ok: true, totalRows: 2, validRows: 1, customers: 1, vehicles: 1, errorRows: 1 });
    expect(clientOf().calls).toEqual([]);
  });

  it("refuses technicians and signed-out sessions", async () => {
    harness.context = context("technician");
    expect(await previewCustomerImportAction({ fileName: "a.csv", csv })).toEqual({ ok: false, message: "Only owners and managers can import customers." });
    harness.context = null;
    expect(await previewCustomerImportAction({ fileName: "a.csv", csv })).toMatchObject({ ok: false });
  });

  it("sends a member who owes an MFA step-up to the challenge", async () => {
    harness.context = context("owner", { mfaRequired: true, mfaVerified: false });
    await expect(previewCustomerImportAction({ fileName: "a.csv", csv })).rejects.toThrow("REDIRECT:/app/mfa?returnTo=%2Fapp%2Fcustomers%2Fimport&stepUp=1");
  });
});

describe("importCustomersAction", () => {
  it("requires the declaration", async () => {
    const result = await importCustomersAction({ fileName: "a.csv", csv, declarationAccepted: false });
    expect(result).toEqual({ ok: false, message: "Tick the declaration to confirm you hold these customers' consent." });
    expect(clientOf().calls).toEqual([]);
  });

  it("imports through the RLS client's RPCs with the garage's declaration and no garage id", async () => {
    const result = await importCustomersAction({ fileName: "customers.csv", csv, declarationAccepted: true });
    expect(result).toMatchObject({ ok: true, importedRows: 1, skippedRows: 1, counts: { customersCreated: 1, consentRecorded: 1 } });
    const calls = clientOf().calls;
    expect(calls.map((call) => (call.kind === "rpc" ? call.name : call.table))).toEqual(["start_customer_import", "import_customer_rows", "finish_customer_import"]);
    const [start, batch] = calls as Array<Extract<Call, { kind: "rpc" }>>;
    expect(start!.args.p_declaration_text).toBe(
      `I confirm these customers gave their details to ${garage.name} when buying or booking a service, were told they could opt out of reminders, and have not opted out, or have given consent to receive reminders.`,
    );
    expect(start!.args.p_summary).toMatchObject({ total_rows: 2, valid_rows: 1, invalid_rows: 1, errors: [{ row: 3, field: "mobile" }] });
    expect(batch!.args.p_rows).toEqual([{ name: "Sam Driver", phone: "+447700900123", email: "sam@example.com", registration: "AB12CDE", consent: true }]);
    expect(JSON.stringify(calls)).not.toContain(garage.id);
    expect(harness.audits).toEqual([[garage.id, expect.objectContaining({ action: "customers.imported", entityType: "customer_import" })]]);
  });

  it("starts a bounded first enrichment batch for this garage after the response", async () => {
    await importCustomersAction({ fileName: "customers.csv", csv, declarationAccepted: true });
    expect(harness.enrich).not.toHaveBeenCalled();
    expect(harness.afterCallbacks).toHaveLength(1);
    await harness.afterCallbacks[0]!();
    expect(harness.enrich).toHaveBeenCalledWith({ garageId: garage.id, importId: "00000000-0000-4000-8000-000000000001", limit: 25 });
  });

  it("imports 1,000 rows in two batches", async () => {
    const result = await importCustomersAction({ fileName: "big.csv", csv: ["Name,Mobile,Consent", ...rows(1000)].join("\n"), declarationAccepted: true });
    expect(result).toMatchObject({ ok: true, importedRows: 1000, counts: { customersCreated: 1000 } });
    const batches = clientOf().calls.filter((call) => call.kind === "rpc" && call.name === "import_customer_rows");
    expect(batches.map((call) => (call as Extract<Call, { kind: "rpc" }>).args.p_rows)).toEqual([expect.any(Array), expect.any(Array)]);
  });

  it("closes the import as failed when a batch fails", async () => {
    clientOf().rpcResults.import_customer_rows = () => ({ data: null, error: { code: "P0001", message: "INVALID_IMPORT_ROWS" } });
    const result = await importCustomersAction({ fileName: "a.csv", csv, declarationAccepted: true });
    expect(result).toMatchObject({ ok: false });
    expect(clientOf().calls.at(-1)).toEqual({ kind: "rpc", name: "finish_customer_import", args: { p_import_id: "00000000-0000-4000-8000-000000000001", p_status: "failed" } });
    expect(harness.afterCallbacks).toHaveLength(0);
  });

  it("refuses technicians before touching the database", async () => {
    harness.context = context("technician");
    expect(await importCustomersAction({ fileName: "a.csv", csv, declarationAccepted: true })).toMatchObject({ ok: false });
    expect(clientOf().calls).toEqual([]);
  });
});

describe("searchCustomersAction", () => {
  it("searches on the RLS client from the POST body", async () => {
    const form = new FormData();
    form.set("q", "Sam");
    form.set("page", "2");
    const result = await searchCustomersAction({ items: [], total: 0, page: 1, pageCount: 1, query: "", error: false }, form);
    expect(result).toMatchObject({ error: false, query: "Sam", page: 1 });
    const customers = clientOf().calls.find((call) => call.kind === "from" && call.table === "customers") as Extract<Call, { kind: "from" }>;
    expect(customers.ops).toContainEqual(["or", ['name.ilike."*Sam*",email.ilike."*Sam*"']]);
    expect(JSON.stringify(clientOf().calls)).not.toContain(garage.id);
  });

  it("returns nothing without a session", async () => {
    harness.context = null;
    const result = await searchCustomersAction({ items: [], total: 0, page: 1, pageCount: 1, query: "", error: false }, new FormData());
    expect(result).toMatchObject({ items: [], error: true });
  });
});

describe("optOutCustomerAction", () => {
  it("sets opted_out_at once, on the RLS client, and audits it in the selected garage", async () => {
    const form = new FormData();
    form.set("customerId", "6c1a1f7e-3d6c-4c39-9a56-2f7f9a4f1b10");
    form.set("garageId", other.id);
    await optOutCustomerAction(form);
    const update = clientOf().calls.find((call) => call.kind === "from") as Extract<Call, { kind: "from" }>;
    expect(update.table).toBe("customers");
    expect(update.ops[0]).toEqual(["update", [{ opted_out_at: expect.any(String) }]]);
    expect(update.ops).toContainEqual(["eq", ["id", "6c1a1f7e-3d6c-4c39-9a56-2f7f9a4f1b10"]]);
    expect(update.ops).toContainEqual(["is", ["opted_out_at", null]]);
    expect(JSON.stringify(update)).not.toContain(other.id);
    expect(harness.audits).toEqual([[garage.id, expect.objectContaining({ action: "customer.opted_out", entityId: "6c1a1f7e-3d6c-4c39-9a56-2f7f9a4f1b10" })]]);
  });

  it("ignores a malformed id", async () => {
    const form = new FormData();
    form.set("customerId", "not-a-uuid");
    await expect(optOutCustomerAction(form)).rejects.toThrow("REDIRECT:/app/customers");
    expect(clientOf().calls).toEqual([]);
  });
});
