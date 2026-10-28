import { z } from "zod";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getInvoiceForAdmin } from "@/lib/invoices/repository";
import { invoiceFileName, renderInvoicePdf } from "@/lib/invoices/pdf";
import { getAdminContext } from "@/lib/tenancy/admin";
import { getInvoiceAccount } from "@/lib/accounts/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAdminContext();
  if (!auth) return Response.json({ error: "Unauthorised" }, { status: 401, headers: privateHeaders });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invoice not found" }, { status: 404, headers: privateHeaders });
  // Read through the RLS garage client: another garage's invoice id is simply not found.
  const invoice = await getInvoiceForAdmin(id);
  if (!invoice) return Response.json({ error: "Invoice not found" }, { status: 404, headers: privateHeaders });
  // P5.7: an invoice charged to a fleet or trade account is billed to the account, with its PO.
  const account = await getInvoiceAccount(auth.client, auth.garage.id, id);
  const pdf = account
    ? await renderInvoicePdf(invoice, auth.garage, { name: account.billToName, email: account.billToEmail, address: account.billToAddress, poNumber: account.poNumber })
    : await renderInvoicePdf(invoice, auth.garage);
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  await recordAdminAudit(auth.garage.id, { actorId: auth.user.id, action: "invoice.pdf_downloaded", entityType: "invoice", entityId: id, detail: { preview } });
  return new Response(new Uint8Array(pdf), { headers: { ...privateHeaders, "Content-Type": "application/pdf", "Content-Disposition": `${preview ? "inline" : "attachment"}; filename="${invoiceFileName(invoice)}"`, "X-Content-Type-Options": "nosniff" } });
}

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };
