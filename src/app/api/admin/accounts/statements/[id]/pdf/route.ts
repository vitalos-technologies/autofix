import { z } from "zod";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getStatementDetail } from "@/lib/accounts/queries";
import { renderStatementPdf } from "@/lib/accounts/statement-pdf";
import { statementFileName } from "@/lib/accounts/view";
import { getAdminContext } from "@/lib/tenancy/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

/**
 * GET /api/admin/accounts/statements/[id]/pdf (P5.7): the statement as a PDF. Admin session; read
 * through the RLS client, so another garage's statement is a 404. A read: a garage back on
 * Essentials can still download the statements it made on Pro (A346).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return Response.json({ error: "Unauthorised" }, { status: 401, headers: privateHeaders });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Statement not found" }, { status: 404, headers: privateHeaders });
  const detail = await getStatementDetail(admin.client, admin.garage.id, id);
  if (!detail) return Response.json({ error: "Statement not found" }, { status: 404, headers: privateHeaders });
  const pdf = await renderStatementPdf(detail, admin.garage);
  await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "account.statement_downloaded", entityType: "account_statement", entityId: id, detail: { format: "pdf" } });
  return new Response(new Uint8Array(pdf), {
    headers: {
      ...privateHeaders,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${statementFileName(detail.statement.reference, "pdf")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
