import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { importBatches, type ParsedImport } from "./csv";

// Runs a validated import through the staff RPCs on the caller's RLS client
// (supabase/migrations/20261028000200_customer_imports.sql): one
// start_customer_import(), one import_customer_rows() per batch of up to 500
// rows (a customer's rows stay in one batch), then finish_customer_import().
// The garage is the client's selected garage; it is never a parameter.

export const IMPORT_BATCH_SIZE = 500;

export type ImportCounts = {
  customersCreated: number;
  customersUpdated: number;
  vehiclesCreated: number;
  vehiclesUpdated: number;
  consentRecorded: number;
};

export type RunImportResult =
  | { ok: true; importId: string; counts: ImportCounts; importedRows: number }
  | { ok: false; code: "UNAUTHORISED" | "FAILED"; importId?: string };

type BatchResult = {
  customers_created: number;
  customers_updated: number;
  vehicles_created: number;
  vehicles_updated: number;
  consent_recorded: number;
};

/** At most this many row problems are stored on the import. */
const STORED_ERRORS = 500;

export async function runCustomerImport(
  client: SupabaseClient,
  input: { fileName: string; parsed: ParsedImport; declarationText: string | null },
): Promise<RunImportResult> {
  const { parsed } = input;
  const started = await client.rpc("start_customer_import", {
    p_file_name: input.fileName.slice(0, 200) || "customers.csv",
    p_summary: {
      total_rows: parsed.totalRows,
      valid_rows: parsed.rows.length,
      invalid_rows: new Set(parsed.errors.map((issue) => issue.row)).size,
      duplicate_rows: parsed.duplicates.length,
      errors: parsed.errors.slice(0, STORED_ERRORS),
    },
    p_declaration_text: input.declarationText,
  });
  if (started.error || typeof started.data !== "string") {
    return { ok: false, code: started.error?.code === "42501" ? "UNAUTHORISED" : "FAILED" };
  }
  const importId = started.data;

  const counts: ImportCounts = { customersCreated: 0, customersUpdated: 0, vehiclesCreated: 0, vehiclesUpdated: 0, consentRecorded: 0 };
  let importedRows = 0;
  for (const batch of importBatches(parsed.rows, IMPORT_BATCH_SIZE)) {
    const { data, error } = await client.rpc("import_customer_rows", {
      p_import_id: importId,
      p_rows: batch.map(({ name, phone, email, registration, consent }) => ({ name, phone, email, registration, consent })),
    });
    if (error || !data) {
      await client.rpc("finish_customer_import", { p_import_id: importId, p_status: "failed" });
      return { ok: false, code: error?.code === "42501" ? "UNAUTHORISED" : "FAILED", importId };
    }
    const result = data as BatchResult;
    counts.customersCreated += Number(result.customers_created);
    counts.customersUpdated += Number(result.customers_updated);
    counts.vehiclesCreated += Number(result.vehicles_created);
    counts.vehiclesUpdated += Number(result.vehicles_updated);
    counts.consentRecorded += Number(result.consent_recorded);
    importedRows += batch.length;
  }

  const finished = await client.rpc("finish_customer_import", { p_import_id: importId, p_status: "completed" });
  if (finished.error) return { ok: false, code: "FAILED", importId };
  return { ok: true, importId, counts, importedRows };
}
