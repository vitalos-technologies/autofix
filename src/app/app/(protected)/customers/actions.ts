"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { recordAdminAudit } from "@/lib/admin/audit";
import { parseCustomerCsv, type ImportIssue, type ImportRow, type ParsedImport } from "@/lib/customers/csv";
import { importDeclaration } from "@/lib/customers/declaration";
import { enrichImportedVehicles } from "@/lib/customers/enrichment";
import { runCustomerImport, type ImportCounts } from "@/lib/customers/import";
import { enqueueJob } from "@/lib/jobs/queue";
import { CUSTOMER_PAGE_SIZE, listCustomers, type CustomerListResult } from "@/lib/customers/queries";
import { getAdminContext } from "@/lib/tenancy/admin";

// Customers & cars actions. The garage is always the signed-in member's
// selected garage (getAdminContext) and every read and write goes through its
// RLS client; nothing here takes a garage id from the request. Search terms
// and CSV contents travel in POST bodies, never URLs, and are never logged.

/** Vehicles looked up straight after an import; the job queue does the rest (P3.7). */
const FIRST_ENRICHMENT_BATCH = 25;

const IMPORT_ROLES = new Set(["owner", "manager"]);

async function adminForWrite(returnTo: string) {
  const admin = await getAdminContext({ requireMfa: false });
  if (admin?.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (admin?.mfaRequired && !admin.mfaVerified) redirect(`/app/mfa?returnTo=${encodeURIComponent(returnTo)}&stepUp=1`);
  return admin;
}

// ---------------------------------------------------------------------------
// Search (POST body; never in the URL)
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  q: z.string().max(200).optional().default(""),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
});

export async function searchCustomersAction(_previous: CustomerListResult, formData: FormData): Promise<CustomerListResult> {
  const parsed = searchSchema.safeParse({ q: formData.get("q") ?? undefined, page: formData.get("page") ?? undefined });
  const empty: CustomerListResult = { items: [], total: 0, page: 1, pageCount: 1, query: "", error: true };
  if (!parsed.success) return empty;
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return empty;
  return listCustomers(admin.client, { query: parsed.data.q, page: parsed.data.page, pageSize: CUSTOMER_PAGE_SIZE });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const fileSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().max(3 * 1024 * 1024),
});

export type ImportPreview = {
  ok: true;
  fileName: string;
  columns: ParsedImport["columns"];
  hasConsentColumn: boolean;
  totalRows: number;
  validRows: number;
  customers: number;
  vehicles: number;
  consenting: number;
  duplicates: number;
  errorRows: number;
  /** First problems, by row. */
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** First rows that will be imported. */
  sample: Array<Pick<ImportRow, "row" | "name" | "phone" | "registration" | "consent"> & { email: string | null }>;
};

export type ImportFailure = { ok: false; message: string };

const PREVIEW_ISSUES = 200;
const PREVIEW_SAMPLE = 8;

function previewOf(fileName: string, parsed: ParsedImport): ImportPreview {
  return {
    ok: true,
    fileName,
    columns: parsed.columns,
    hasConsentColumn: parsed.hasConsentColumn,
    totalRows: parsed.totalRows,
    validRows: parsed.rows.length,
    customers: new Set(parsed.rows.map((row) => row.phone)).size,
    vehicles: parsed.rows.filter((row) => row.registration).length,
    consenting: new Set(parsed.rows.filter((row) => row.consent).map((row) => row.phone)).size,
    duplicates: parsed.duplicates.length,
    errorRows: new Set(parsed.errors.map((issue) => issue.row)).size,
    errors: parsed.errors.slice(0, PREVIEW_ISSUES),
    warnings: parsed.warnings.slice(0, PREVIEW_ISSUES),
    sample: parsed.rows.slice(0, PREVIEW_SAMPLE).map(({ row, name, phone, email, registration, consent }) => ({ row, name, phone, email, registration, consent })),
  };
}

async function importer() {
  const admin = await adminForWrite("/app/customers/import");
  if (!admin) return { error: "Your session has expired. Refresh and sign in again." } as const;
  if (!IMPORT_ROLES.has(admin.role)) return { error: "Only owners and managers can import customers." } as const;
  return { admin } as const;
}

/** Checks a file and returns what an import would do. Writes nothing. */
export async function previewCustomerImportAction(input: { fileName: string; csv: string }): Promise<ImportPreview | ImportFailure> {
  const access = await importer();
  if ("error" in access) return { ok: false, message: access.error! };
  const file = fileSchema.safeParse(input);
  if (!file.success) return { ok: false, message: "Choose a CSV file of up to 2 MB." };
  const parsed = parseCustomerCsv(file.data.csv);
  if (parsed.fatal) return { ok: false, message: parsed.fatal };
  return previewOf(file.data.fileName, parsed);
}

export type ImportOutcome = {
  ok: true;
  importId: string;
  importedRows: number;
  skippedRows: number;
  counts: ImportCounts;
  durationMs: number;
};

/**
 * Imports a file. The file is parsed and validated again here (the preview is
 * advisory) and the consent declaration must be ticked: its wording, with the
 * garage's name, is stored on the import and as each consenting customer's
 * consent text.
 */
export async function importCustomersAction(input: { fileName: string; csv: string; declarationAccepted: boolean }): Promise<ImportOutcome | ImportFailure> {
  const startedAt = Date.now();
  const access = await importer();
  if ("error" in access) return { ok: false, message: access.error! };
  const { admin } = access;
  if (input?.declarationAccepted !== true) return { ok: false, message: "Tick the declaration to confirm you hold these customers' consent." };
  const file = fileSchema.safeParse(input);
  if (!file.success) return { ok: false, message: "Choose a CSV file of up to 2 MB." };
  const parsed = parseCustomerCsv(file.data.csv);
  if (parsed.fatal) return { ok: false, message: parsed.fatal };
  if (!parsed.rows.length) return { ok: false, message: "No rows can be imported. Fix the problems listed and try again." };

  const result = await runCustomerImport(admin.client, {
    fileName: file.data.fileName,
    parsed,
    declarationText: importDeclaration(admin.garage.name),
  });
  if (!result.ok) {
    return {
      ok: false,
      message: result.code === "UNAUTHORISED"
        ? "You don't have permission to import customers for this garage."
        : "The import stopped part way. Rows already saved are kept; import the file again to finish.",
    };
  }

  const garageId = admin.garage.id;
  await recordAdminAudit(garageId, {
    actorId: admin.user.id,
    action: "customers.imported",
    entityType: "customer_import",
    entityId: result.importId,
    detail: { rows: result.importedRows, ...result.counts },
  });
  after(async () => {
    let remaining = true;
    let retryAfterMs: number | undefined;
    try {
      const first = await enrichImportedVehicles({ garageId, importId: result.importId, limit: FIRST_ENRICHMENT_BATCH });
      remaining = first.remaining && first.stoppedReason !== "not_configured";
      retryAfterMs = first.retryAfterMs;
    } catch {
      console.warn("[customers.enrich] first batch after import failed", { garageId });
    }
    if (!remaining) return;
    // The rest goes through the job queue (P3.7 `customers.enrich`), drained by the cron or POST /api/jobs/drain.
    try {
      await enqueueJob("customers.enrich", { garageId, importId: result.importId }, {
        garageId,
        dedupeKey: `customers.enrich:${garageId}:import:${result.importId}`,
        ...(retryAfterMs ? { runAt: new Date(Date.now() + retryAfterMs) } : {}),
      });
    } catch {
      console.warn("[customers.enrich] could not queue the rest of the import", { garageId });
    }
  });
  revalidatePath("/app/customers");
  return {
    ok: true,
    importId: result.importId,
    importedRows: result.importedRows,
    skippedRows: parsed.totalRows - result.importedRows,
    counts: result.counts,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

const customerIdSchema = z.string().uuid();

/** Records an opt-out the customer asked for (phone, in person). Never cleared here. */
export async function optOutCustomerAction(formData: FormData) {
  const id = customerIdSchema.safeParse(formData.get("customerId"));
  if (!id.success) redirect("/app/customers");
  const admin = await adminForWrite(`/app/customers/${id.data}`);
  if (!admin) redirect("/app/login");
  const { data, error } = await admin.client
    .from("customers")
    .update({ opted_out_at: new Date().toISOString() })
    .eq("id", id.data)
    .is("opted_out_at", null)
    .is("anonymised_at", null)
    .select("id");
  if (!error && data?.length) {
    await recordAdminAudit(admin.garage.id, {
      actorId: admin.user.id,
      action: "customer.opted_out",
      entityType: "customer",
      entityId: id.data,
      detail: { source: "staff" },
    });
  }
  revalidatePath(`/app/customers/${id.data}`);
  revalidatePath("/app/customers");
}
