import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DPA_KIND, DPA_VERSION, type DpaAcceptance } from "./documents";

// DPA acceptance records (`garage_agreements`, P4.9). Rows are written only by
// accept_garage_agreement() (service role, owner checked in the database);
// staff read their own garage's rows with the RLS client.

export type AgreementRecord = DpaAcceptance & { version: string; textHash: string };

type AgreementRow = { version: string; text_hash: string; accepted_at: string; accepted_by_name: string; accepted_by_role: string };

export type DpaStatus = {
  /** The DPA version the app shows now (from docs/autofix/legal/DPA-template.md). */
  currentVersion: string;
  /** Acceptance of the current version, if any. */
  current: AgreementRecord | null;
  /** Every accepted version, newest first. */
  history: AgreementRecord[];
};

/** The garage's DPA records, read with the caller's client (RLS limits it to the selected garage). */
export async function loadDpaStatus(client: SupabaseClient, garageId: string): Promise<DpaStatus> {
  const { data, error } = await client
    .from("garage_agreements")
    .select("version,text_hash,accepted_at,accepted_by_name,accepted_by_role")
    .eq("garage_id", garageId)
    .eq("kind", DPA_KIND)
    .order("accepted_at", { ascending: false });
  if (error) throw new Error(`agreements load failed: ${error.code ?? "unknown"}`);
  const history = ((data ?? []) as AgreementRow[]).map((row) => ({
    version: row.version,
    textHash: row.text_hash,
    acceptedAt: row.accepted_at,
    acceptedByName: row.accepted_by_name,
    acceptedByRole: row.accepted_by_role,
  }));
  return { currentVersion: DPA_VERSION, current: history.find((record) => record.version === DPA_VERSION) ?? null, history };
}
