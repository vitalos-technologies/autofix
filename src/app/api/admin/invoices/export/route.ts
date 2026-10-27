import { recordAdminAudit } from "@/lib/admin/audit";
import { InvoiceExportValidationError, invoiceExportCsv, loadInvoiceExportRows, normalizeInvoiceExportFilters } from "@/lib/invoices/export";
import { renderInvoiceExportPdf } from "@/lib/invoices/export-pdf";
import { getAdminContext } from "@/lib/tenancy/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  const auth = await getAdminContext();
  if (!auth) return Response.json({ error: "Unauthorised" }, { status: 401, headers: privateHeaders });

  try {
    const filters = normalizeInvoiceExportFilters(new URL(request.url).searchParams);
    // The RLS garage client only returns the selected garage's invoices.
    const rows = await loadInvoiceExportRows(auth.client, filters);
    const extension = filters.format;
    const filename = `Invoices-${filters.fileLabel}.${extension}`;
    const body = filters.format === "csv" ? new TextEncoder().encode(invoiceExportCsv(rows)) : new Uint8Array(await renderInvoiceExportPdf(rows, filters, auth.garage));
    const contentType = filters.format === "csv" ? "text/csv; charset=utf-8" : "application/pdf";
    await recordAdminAudit(auth.garage.id, { actorId: auth.user.id, action: "invoice.exported", entityType: "invoice_export", entityId: filters.fileLabel, detail: { format: filters.format, period: filters.period, status: filters.status, source: filters.source, count: rows.length } });
    return new Response(body, { headers: { ...privateHeaders, "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"` } });
  } catch (error) {
    if (error instanceof InvoiceExportValidationError) return Response.json({ error: error.message }, { status: 400, headers: privateHeaders });
    console.error("[invoice-export] Export failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Invoice export could not be created" }, { status: 500, headers: privateHeaders });
  }
}
