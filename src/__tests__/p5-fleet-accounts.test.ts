import { describe, expect, it, vi } from "vitest";
import { checkBookingAccount } from "@/lib/accounts/bookings";
import { accountsStatementsHandler } from "@/lib/accounts/jobs";
import type { StatementDetail } from "@/lib/accounts/queries";
import { renderStatementEmail, sendStatementEmail } from "@/lib/accounts/statement-email";
import {
  accountErrorMessage,
  accountFormValues,
  accountInvoiceTerms,
  cleanPoNumber,
  creditPosition,
  currentStatementMonth,
  isMonthStart,
  lineBalance,
  normaliseCompanyNumber,
  parseAccountForm,
  periodLabel,
  previousStatementMonth,
  recentStatementMonths,
  statementCsv,
  statementFileName,
  statementTotals,
  type StatementLine,
} from "@/lib/accounts/view";
import { JOB_DEFINITIONS } from "@/lib/jobs/registry";
import { CRON_JOBS } from "@/lib/jobs/cron";
import { JOB_KINDS, type JobContext } from "@/lib/jobs/types";
import type { MessageChannel, OutboundMessage } from "@/lib/messaging/channel";
import { createFakeSupabase } from "./support/fake-supabase";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const validAccount = {
  name: "  Northern   Vans Ltd ",
  kind: "fleet",
  companyNumber: "1234567",
  billingEmail: "Accounts@Northern.example",
  billingAddress: "1 Depot Road\r\nLeeds",
  contactName: "Sam Fleet",
  contactPhone: "07700 900123",
  contactEmail: "",
  billing: "monthly",
  paymentTermsDays: "30",
  poRequired: "on",
  discountPercent: "7.5%",
  creditLimit: "2,500",
  notes: "",
};

describe("account form", () => {
  it("normalises a valid account", () => {
    const parsed = parseAccountForm(form(validAccount));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      name: "Northern Vans Ltd",
      kind: "fleet",
      company_number: "01234567",
      billing_email: "accounts@northern.example",
      billing_address: "1 Depot Road\nLeeds",
      contact_name: "Sam Fleet",
      contact_phone: "+447700900123",
      contact_email: null,
      payment_terms_days: 30,
      po_required: true,
      discount_percent: 7.5,
      credit_limit_pence: 250000,
      billing: "monthly",
      notes: null,
    });
    expect(accountFormValues(parsed.value)).toMatchObject({ companyNumber: "01234567", creditLimit: "2500", discountPercent: "7.5", poRequired: true });
  });

  it("names every bad field", () => {
    const parsed = parseAccountForm(form({ ...validAccount, name: "A", kind: "lorry", companyNumber: "12-34", billingEmail: "", contactPhone: "123", paymentTermsDays: "365", discountPercent: "120", creditLimit: "lots", billing: "monthly" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.fieldErrors).sort()).toEqual(["billingEmail", "companyNumber", "contactPhone", "creditLimit", "discountPercent", "kind", "name", "paymentTermsDays"].sort());
    expect(parsed.fieldErrors.billingEmail).toMatch(/statements are emailed/i);
  });

  it("lets per-invoice accounts go without an accounts email", () => {
    const parsed = parseAccountForm(form({ ...validAccount, billing: "per_invoice", billingEmail: "", discountPercent: "", creditLimit: "" }));
    expect(parsed.ok && parsed.value.billing_email === null && parsed.value.discount_percent === null && parsed.value.credit_limit_pence === null).toBe(true);
  });

  it("pads numeric company numbers and keeps prefixed ones", () => {
    expect(normaliseCompanyNumber("1234567")).toBe("01234567");
    expect(normaliseCompanyNumber("sc 123456")).toBe("SC123456");
    expect(normaliseCompanyNumber("SC12345")).toBeNull();
    expect(normaliseCompanyNumber("")).toBeNull();
  });

  it("cleans PO numbers", () => {
    expect(cleanPoNumber("  PO-77 ")).toEqual({ ok: true, value: "PO-77" });
    expect(cleanPoNumber("")).toEqual({ ok: true, value: null });
    expect(cleanPoNumber("x".repeat(41)).ok).toBe(false);
  });
});

describe("statement months (Europe/London)", () => {
  it("covers the month before, across the year end and in summer time", () => {
    expect(previousStatementMonth(new Date("2026-11-01T00:30:00Z"))).toBe("2026-10-01");
    expect(previousStatementMonth(new Date("2027-01-01T00:00:00Z"))).toBe("2026-12-01");
    // 23:30 UTC on 30 June is 00:30 on 1 July in London (BST): June is the month before.
    expect(previousStatementMonth(new Date("2026-06-30T23:30:00Z"))).toBe("2026-06-01");
    expect(previousStatementMonth(new Date("2026-06-30T22:30:00Z"))).toBe("2026-05-01");
    // The clock change day (25 October 2026) is still October.
    expect(currentStatementMonth(new Date("2026-10-25T01:30:00Z"))).toBe("2026-10-01");
  });

  it("lists recent months newest first", () => {
    expect(recentStatementMonths(new Date("2026-02-10T12:00:00Z"), "Europe/London", 4)).toEqual(["2026-02-01", "2026-01-01", "2025-12-01", "2025-11-01"]);
    expect(isMonthStart("2026-09-01")).toBe(true);
    expect(isMonthStart("2026-09-02")).toBe(false);
    expect(periodLabel("2026-09-01")).toBe("September 2026");
  });
});

const lines: StatementLine[] = [
  { invoiceId: "i1", invoiceNumber: "HRM-2026-000010", issueDate: "2026-09-03", status: "issued", registration: "AB12CDE", driver: "Dee Driver", serviceName: "Service", poNumber: "PO-1", totalPence: 12000, paidPence: 2000 },
  { invoiceId: "i2", invoiceNumber: "HRM-2026-000011", issueDate: "2026-09-08", status: "paid", registration: null, driver: "=HYPERLINK(\"x\")", serviceName: "Tyres, \"premium\"", poNumber: null, totalPence: 8050, paidPence: 8050 },
  { invoiceId: "i3", invoiceNumber: "HRM-2026-000012", issueDate: "2026-09-09", status: "void", registration: null, driver: "Void", serviceName: null, poNumber: null, totalPence: 999, paidPence: 0 },
];

describe("statement money", () => {
  it("totals issued and paid invoices only", () => {
    expect(lineBalance(lines[0]!)).toBe(10000);
    expect(lineBalance(lines[1]!)).toBe(0);
    expect(statementTotals(lines)).toEqual({ total: 20050, paid: 10050, balance: 10000, count: 2 });
    expect(creditPosition(null, 100)).toBeNull();
    expect(creditPosition(5000, 6000)).toEqual({ over: true, left: -1000 });
  });

  it("writes CSV with quoted cells, neutralised formulas and a total row", () => {
    const csv = statementCsv({ reference: "HRM-ST-202609-001", accountName: "Northern Vans Ltd", periodStart: "2026-09-01" }, lines);
    const rows = csv.trim().split("\r\n");
    expect(rows[0]).toBe('"Statement","Account","Period","Invoice","Issue date","Registration","Driver","Service","PO number","Status","Total","Paid","Balance"');
    expect(rows[1]).toContain('"AB12CDE","Dee Driver","Service","PO-1","Unpaid","120.00","20.00","100.00"');
    expect(rows[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(rows[2]).toContain('"Tyres, ""premium"""');
    expect(rows.at(-1)).toContain('"Total","","","","","","","200.50","100.50","100.00"');
    expect(statementFileName("HRM-ST-202609-001", "csv")).toBe("Statement-HRM-ST-202609-001.csv");
  });

  it("writes account invoice terms", () => {
    expect(accountInvoiceTerms({ name: "Northern Vans Ltd", billing: "monthly", paymentTermsDays: 14, poNumber: "PO-1", discountPercent: 10 })).toEqual({
      paymentTerms: "Charged to Northern Vans Ltd's account. Payable on the monthly statement within 14 days of issue.",
      notes: "PO PO-1. Account discount 10%",
    });
  });
});

describe("account error messages", () => {
  it("maps the database codes to plain English, never the raw text", () => {
    expect(accountErrorMessage({ code: "P0001", message: "PO_REQUIRED" })).toMatch(/purchase order/);
    expect(accountErrorMessage({ code: "P0001", message: "PLAN_REQUIRED: fleet_accounts" })).toMatch(/on Pro/);
    expect(accountErrorMessage({ code: "P0001", message: "VEHICLE_ON_OTHER_ACCOUNT" })).toMatch(/another business account/);
    expect(accountErrorMessage({ code: "23505", message: "duplicate key value violates unique constraint" })).toMatch(/already an active account/);
    expect(accountErrorMessage({ code: "XX000", message: "internal detail" })).toBe("That could not be saved. Try again.");
  });
});

describe("job accounts.statements", () => {
  it("is registered, queued by the daily cron and run after the billing jobs", () => {
    expect(JOB_KINDS).toContain("accounts.statements");
    expect(JOB_DEFINITIONS.find((definition) => definition.kind === "accounts.statements")?.timeoutMs).toBe(18_000);
    expect(CRON_JOBS.daily).toContain("accounts.statements");
    expect(CRON_JOBS["accounts.statements"]).toEqual(["accounts.statements"]);
  });

  function context(now: string) {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "business_accounts") return { data: [{ garage_id: "g2" }, { garage_id: "g1" }, { garage_id: "g1" }] };
        if (query.table === "garages") return { data: [{ id: "g1", timezone: "Europe/London", status: "active" }, { id: "g2", timezone: null, status: "cancelled" }] };
        return { data: [] };
      },
      rpc: () => ({ data: 2 }),
    });
    const info = vi.fn();
    const value = {
      job: { garage_id: null },
      db: fake.client,
      now: () => new Date(now),
      clock: () => 0,
      deadline: 1,
      log: { info, warn: vi.fn(), error: vi.fn() },
    } as unknown as JobContext;
    return { fake, info, value };
  }

  it("makes last month's drafts per garage with monthly accounts, skipping cancelled garages", async () => {
    const { fake, value, info } = context("2026-11-01T00:15:00Z");
    await expect(accountsStatementsHandler({}, value)).resolves.toEqual({ outcome: "made", counts: { garages: 1, statements: 2 } });
    expect(fake.rpcs).toEqual([{ fn: "generate_monthly_account_statements", args: { p_garage_id: "g1", p_period_start: "2026-10-01" } }]);
    expect(info).toHaveBeenCalledWith("accounts.statements_made", { garages: 1, statements: 2 });
    const accounts = fake.queries.find((query) => query.table === "business_accounts")!;
    expect(accounts.filters).toEqual(expect.arrayContaining([{ method: "eq", args: ["billing", "monthly"] }, { method: "is", args: ["archived_at", null] }]));
  });

  it("refuses a payload (it is a platform job)", async () => {
    await expect(accountsStatementsHandler({ garageId: "x" }, context("2026-11-01T00:15:00Z").value)).rejects.toThrow("INVALID_PAYLOAD");
  });
});

const garage = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Hartley Road <Motors>",
  legalName: "Hartley Road Motors Ltd",
  tagline: null,
  accent: "#155fba",
  phone: "+447700900101",
  email: "hello@hartley.example",
  address: { line1: "4 Hartley Road", town: "Leeds", postcode: "LS1 1AA" },
  slug: "hartley-road",
  customDomain: null,
  logoUrl: null,
  companyNumber: "01234567",
  invoicePayment: { accountName: "Hartley Road Motors", sortCode: "00-00-00", accountNumber: "00000000" },
};

const detail = {
  statement: {
    id: "22222222-2222-4222-8222-222222222222",
    reference: "HRM-ST-202609-001",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    status: "issued",
    invoiceCount: 2,
    totalPence: 20050,
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    emailedAt: null,
    paidAt: null,
    paymentMethod: null,
    paymentReference: null,
    emailedTo: null,
    emailStatus: null,
  },
  account: { id: "a1", name: "Northern <Vans>", contact_name: null, billing_email: "accounts@northern.example", payment_terms_days: 30 },
  lines: lines.slice(0, 2),
  totals: statementTotals(lines.slice(0, 2)),
} as unknown as StatementDetail;

describe("statement email", () => {
  it("renders the statement with escaped names and the balance", () => {
    const email = renderStatementEmail(garage, detail);
    expect(email.html).toContain("Northern &lt;Vans&gt;");
    expect(email.html).not.toContain("Northern <Vans>");
    expect(email.html).toContain("£100.00");
    expect(email.html).toContain("AB12 CDE");
    expect(email.text).toContain("Balance due: £100.00");
    expect(email.text).toContain("Please quote HRM-ST-202609-001");
    expect(email.text).not.toContain("undefined");
  });

  it("sends through the email channel with a key per deliberate send", async () => {
    const sent: OutboundMessage[] = [];
    const channel: MessageChannel = { kind: "email", mode: "mock", send: async (message) => { sent.push(message); return { ok: true, providerMessageId: "mock_1", status: "sent" }; } };
    await expect(sendStatementEmail({ garage, detail, recipient: "accounts@northern.example", sendNumber: 2, channel })).resolves.toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ garageId: garage.id, to: "accounts@northern.example", idempotencyKey: `account_statement:${detail.statement.id}:2` });
    expect(sent[0]?.subject).toBe("Statement HRM-ST-202609-001 from Hartley Road <Motors>");
    await expect(sendStatementEmail({ garage, detail, recipient: "not-an-email", sendNumber: 1, channel })).resolves.toMatchObject({ ok: false, code: "invalid_recipient" });
    expect(sent).toHaveLength(1);
  });
});

describe("fleet bookings: checkBookingAccount", () => {
  const pro = { id: "g1", plan: "pro", trialEndsAt: null, planChosen: "pro" };
  const essentials = { id: "g1", plan: "essentials", trialEndsAt: null, planChosen: "essentials" };
  const accountId = "33333333-3333-4333-8333-333333333333";

  function admin(garagePlan: typeof pro, rows: { account?: unknown; vehicle?: unknown }) {
    const fake = createFakeSupabase({
      from: (query) => (query.table === "business_accounts" ? { data: rows.account ?? null } : query.table === "vehicles" ? { data: rows.vehicle ?? null } : { data: null }),
    });
    return { fake, admin: { client: fake.client, garage: garagePlan } as unknown as Parameters<typeof checkBookingAccount>[0] };
  }

  it("does nothing without an account", async () => {
    const { admin: value, fake } = admin(pro, {});
    await expect(checkBookingAccount(value, { accountId: "", poNumber: "", registration: "AB12CDE" })).resolves.toEqual({ ok: true, value: null });
    expect(fake.queries).toHaveLength(0);
  });

  it("refuses an Essentials garage before reading anything", async () => {
    const { admin: value, fake } = admin(essentials, {});
    const result = await checkBookingAccount(value, { accountId, poNumber: "", registration: "AB12CDE" });
    expect(result.ok).toBe(false);
    expect(fake.queries).toHaveLength(0);
  });

  it("needs a PO when the account does, and refuses a car on another account", async () => {
    const needsPo = admin(pro, { account: { id: accountId, po_required: true } });
    await expect(checkBookingAccount(needsPo.admin, { accountId, poNumber: " ", registration: "AB12CDE" })).resolves.toMatchObject({ ok: false, fieldErrors: { poNumber: "Enter the PO number" } });
    const elsewhere = admin(pro, { account: { id: accountId, po_required: false }, vehicle: { id: "v1", business_account_vehicles: [{ account_id: "44444444-4444-4444-8444-444444444444" }] } });
    await expect(checkBookingAccount(elsewhere.admin, { accountId, poNumber: "PO-1", registration: "AB12CDE" })).resolves.toMatchObject({ ok: false, fieldErrors: { registration: expect.any(String) } });
    const fine = admin(pro, { account: { id: accountId, po_required: true }, vehicle: { id: "v1", business_account_vehicles: [] } });
    await expect(checkBookingAccount(fine.admin, { accountId, poNumber: "PO-1", registration: "AB12CDE" })).resolves.toEqual({ ok: true, value: { accountId, poNumber: "PO-1" } });
    const accountQuery = fine.fake.queries.find((query) => query.table === "business_accounts")!;
    expect(accountQuery.filters).toEqual(expect.arrayContaining([{ method: "eq", args: ["garage_id", "g1"] }, { method: "is", args: ["archived_at", null] }]));
  });
});
