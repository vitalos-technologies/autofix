import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Daily retention (Vercel Cron, `Authorization: Bearer CRON_SECRET`).
 * `apply_enquiry_retention` is scoped to one garage, so it runs once per
 * garage. Every garage is included, cancelled ones too: retention limits
 * apply to whatever data a garage still holds. The response carries totals
 * only, never garage ids or names.
 */
export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const { data: garages, error: garagesError } = await admin.from("garages").select("id").order("created_at", { ascending: true });
  if (garagesError) return NextResponse.json({ error: "Retention task failed" }, { status: 500 });

  let anonymisedRecords = 0;
  let failedGarages = 0;
  for (const garage of garages ?? []) {
    const { data, error } = await admin.rpc("apply_enquiry_retention", { p_garage_id: garage.id });
    if (error) {
      failedGarages += 1;
      continue;
    }
    anonymisedRecords += typeof data === "number" ? data : 0;
  }
  const processedGarages = (garages ?? []).length - failedGarages;
  if (failedGarages > 0) {
    return NextResponse.json({ error: "Retention task failed for some garages", processedGarages, failedGarages, anonymisedRecords }, { status: 500 });
  }
  return NextResponse.json({ success: true, processedGarages, anonymisedRecords });
}
