import { beforeEach, describe, expect, it, vi } from "vitest";
import { testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({
  admin: null as Record<string, unknown> | null,
  getAdminContext: vi.fn(),
  renderInvoicePdf: vi.fn(),
  renderInvoiceExportPdf: vi.fn(),
  loadInvoiceExportRows: vi.fn(),
  recordAdminAudit: vi.fn(async () => true),
}));

vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: harness.getAdminContext }));
vi.mock("@/lib/admin/audit", () => ({ recordAdminAudit: harness.recordAdminAudit }));
vi.mock("@/lib/invoices/repository", () => ({
  getInvoiceForAdmin: vi.fn(async () => ({
    id: "invoice-id",
    invoice_number: "HRM-2026-000001",
  })),
}));
vi.mock("@/lib/invoices/pdf", () => ({
  renderInvoicePdf: harness.renderInvoicePdf,
  invoiceFileName: (invoice: { invoice_number: string | null }) => `Invoice-${invoice.invoice_number || "Draft"}.pdf`,
}));
vi.mock("@/lib/invoices/export", () => ({
  InvoiceExportValidationError: class InvoiceExportValidationError extends Error {},
  normalizeInvoiceExportFilters: vi.fn(() => ({ format: "csv", period: "all", startDate: null, endDate: null, status: null, source: null, label: "All dates", fileLabel: "all-dates" })),
  loadInvoiceExportRows: harness.loadInvoiceExportRows,
  invoiceExportCsv: vi.fn(() => "Invoice number\r\n"),
}));
vi.mock("@/lib/invoices/export-pdf", () => ({ renderInvoiceExportPdf: harness.renderInvoiceExportPdf }));

import { GET as invoicePdf } from "@/app/api/admin/invoices/[id]/pdf/route";
import { GET as invoiceExport } from "@/app/api/admin/invoices/export/route";

const invoiceId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const garage = testGarage();
const rlsClient = { tag: "rls-garage-client" };

describe("admin API authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.admin = null;
    harness.getAdminContext.mockImplementation(async () => harness.admin);
    harness.renderInvoicePdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
    harness.renderInvoiceExportPdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
    harness.loadInvoiceExportRows.mockResolvedValue([]);
  });

  it("returns 401 with no-store before handling either endpoint", async () => {
    const pdfResponse = await invoicePdf(new Request(`https://autofix.vitalos.co.uk/api/admin/invoices/${invoiceId}/pdf`), {
      params: Promise.resolve({ id: invoiceId }),
    });
    expect(pdfResponse.status).toBe(401);
    expect(pdfResponse.headers.get("cache-control")).toContain("private");
    expect(pdfResponse.headers.get("cache-control")).toContain("no-store");
    expect(harness.renderInvoicePdf).not.toHaveBeenCalled();

    const exportResponse = await invoiceExport(new Request("https://autofix.vitalos.co.uk/api/admin/invoices/export?format=csv"));
    expect(exportResponse.status).toBe(401);
    expect(exportResponse.headers.get("cache-control")).toContain("no-store");
    expect(harness.loadInvoiceExportRows).not.toHaveBeenCalled();
  });

  it("serves a garage-branded private PDF after the strict admin guard succeeds", async () => {
    harness.admin = { user: { id: "admin-id" }, garage, client: rlsClient, mfaVerified: true };
    const response = await invoicePdf(new Request(`https://autofix.vitalos.co.uk/api/admin/invoices/${invoiceId}/pdf?preview=1`), {
      params: Promise.resolve({ id: invoiceId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="Invoice-HRM-2026-000001.pdf"');
    expect(harness.renderInvoicePdf).toHaveBeenCalledWith(expect.objectContaining({ id: "invoice-id" }), garage);
    expect(harness.recordAdminAudit).toHaveBeenCalledWith(garage.id, expect.objectContaining({ action: "invoice.pdf_downloaded" }));
  });

  it("rejects a malformed invoice id without loading anything", async () => {
    harness.admin = { user: { id: "admin-id" }, garage, client: rlsClient, mfaVerified: true };
    const response = await invoicePdf(new Request("https://autofix.vitalos.co.uk/api/admin/invoices/not-an-id/pdf"), { params: Promise.resolve({ id: "not-an-id" }) });
    expect(response.status).toBe(404);
    expect(harness.renderInvoicePdf).not.toHaveBeenCalled();
  });

  it("exports through the admin's RLS garage client, never the service role", async () => {
    harness.admin = { user: { id: "admin-id" }, garage, client: rlsClient, mfaVerified: true };
    const response = await invoiceExport(new Request("https://autofix.vitalos.co.uk/api/admin/invoices/export?format=csv"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("Invoices-all-dates.csv");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(harness.loadInvoiceExportRows).toHaveBeenCalledWith(rlsClient, expect.any(Object));
    expect(harness.recordAdminAudit).toHaveBeenCalledWith(garage.id, expect.objectContaining({ action: "invoice.exported" }));
  });
});
