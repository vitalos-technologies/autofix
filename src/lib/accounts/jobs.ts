import "server-only";

import { z } from "zod";
import { parsePayload } from "@/lib/jobs/payloads";
import { databaseError, type JobHandler } from "@/lib/jobs/types";
import { previousStatementMonth } from "./view";

// Job kind `accounts.statements` (P5.7): the monthly statements of fleet and trade accounts.
// Queued by the `daily` cron. For each garage with an active monthly-billed account it makes (or
// refreshes) the draft statement for the month before the garage's current month (Europe/London
// by default), through generate_monthly_account_statements(), which is idempotent per account and
// month and does nothing for a garage not on Pro. So the 1st of the month makes last month's
// drafts, and a missed run is caught up the next day. Nothing is emailed here: staff check, issue
// and email each statement.

export const accountsStatementsPayload = z.object({}).strict();

export const accountsStatementsHandler: JobHandler = async (payload, context) => {
  parsePayload(accountsStatementsPayload, payload, context.job);
  const { data: accounts, error } = await context.db
    .from("business_accounts")
    .select("garage_id")
    .eq("billing", "monthly")
    .is("archived_at", null)
    .limit(10000);
  if (error) throw databaseError("business_accounts.list", error);
  const garageIds = [...new Set(((accounts ?? []) as Array<{ garage_id: string }>).map((row) => row.garage_id))].sort();
  if (!garageIds.length) return { outcome: "none", counts: { garages: 0, statements: 0 } };

  const { data: garages, error: garageError } = await context.db.from("garages").select("id,timezone,status").in("id", garageIds);
  if (garageError) throw databaseError("garages.list", garageError);

  let statements = 0;
  let checked = 0;
  for (const garage of (garages ?? []) as Array<{ id: string; timezone: string | null; status: string }>) {
    if (garage.status === "cancelled") continue;
    if (context.clock() > context.deadline) break;
    const month = previousStatementMonth(context.now(), garage.timezone || "Europe/London");
    const result = await context.db.rpc("generate_monthly_account_statements", { p_garage_id: garage.id, p_period_start: month });
    if (result.error) throw databaseError("generate_monthly_account_statements", result.error);
    statements += typeof result.data === "number" ? result.data : 0;
    checked += 1;
  }
  context.log.info("accounts.statements_made", { garages: checked, statements });
  return { outcome: statements ? "made" : "none", counts: { garages: checked, statements } };
};
