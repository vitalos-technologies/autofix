import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportRange } from "./range";
import { loadCampaignRoi, loadHours, loadReminderRoi, loadRevenueByService, loadRevenueByTechnician, loadUtilisation } from "./server";
import { hoursCsv, reminderRoiCsv, revenueCsv, utilisationCsv, type ReportKind } from "./shape";

/** The CSV for one report, read through the admin's RLS client (garage, role and plan checked in SQL). */
export async function buildReportCsv(
  client: SupabaseClient,
  kind: ReportKind,
  range: Pick<ReportRange, "from" | "to">,
  costPerSegmentPence: number | null,
): Promise<{ csv: string; rows: number }> {
  switch (kind) {
    case "revenue-by-service": {
      const rows = await loadRevenueByService(client, range);
      return { csv: revenueCsv(rows, "Service"), rows: rows.length };
    }
    case "revenue-by-technician": {
      const rows = await loadRevenueByTechnician(client, range);
      return { csv: revenueCsv(rows, "Technician"), rows: rows.length };
    }
    case "bay-utilisation": {
      const days = await loadUtilisation(client, range);
      return { csv: utilisationCsv(days), rows: days.length };
    }
    case "hours": {
      const rows = await loadHours(client, range);
      return { csv: hoursCsv(rows), rows: rows.length };
    }
    case "reminder-roi": {
      const [rows, campaign] = await Promise.all([loadReminderRoi(client, range), loadCampaignRoi(client, range)]);
      return { csv: reminderRoiCsv(rows, campaign, costPerSegmentPence), rows: rows.length };
    }
  }
}
