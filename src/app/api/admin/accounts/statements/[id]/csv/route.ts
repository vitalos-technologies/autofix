import { z } from "zod";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getStatementDetail } from "@/lib/accounts/queries";
import { statementCsv, statementFileName } from "@/lib/accounts/view";
import { getAdminContext } from "@/lib/tenancy/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

/** GET /api/admin/accounts/statements/[id]/csv (P5.7): the statement's invoices as CSV (RLS read; 404 for another garage's). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return Response.json({ error: "Unauthorised" }, { status: 401, headers: privateHeaders });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Statement not found" }, { status: 404, headers: privateHeaders });
  const detail = await getStatementDetail(admin.client, admin.garage.id, id);
  if (!detail) return Response.json({ error: "Statement not found" }, { status: 404, headers: privateHeaders });
  const csv = statementCsv({ reference: detail.statement.reference, accountName: detail.account.name, periodStart: detail.statement.periodStart }, detail.lines);
  await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "account.statement_downloaded", entityType: "account_statement", entityId: id, detail: { format: "csv" } });
  return new Response(`﻿${csv}`, {
    headers: {
      ...privateHeaders,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${statementFileName(detail.statement.reference, "csv")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
