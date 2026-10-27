import type { NextRequest } from "next/server";
import { handleCronRequest } from "@/lib/jobs/http";

/**
 * Vercel Cron (`Authorization: Bearer CRON_SECRET`, checked in constant time). `[job]` is `daily`
 * (Hobby: everything once a day) or one kind: `reminders.schedule`, `reminders.send`,
 * `mot.refresh`, `domains.check`, `retention`. Queues the platform job for the current period
 * (dedupe key per day, or per 10/5-minute slot for sends/domains), then drains due jobs for up to
 * 20 seconds. Answers with counts only.
 */
export const maxDuration = 60;

export async function GET(request: NextRequest, context: { params: Promise<{ job: string }> }) {
  const { job } = await context.params;
  return handleCronRequest(request, job);
}
