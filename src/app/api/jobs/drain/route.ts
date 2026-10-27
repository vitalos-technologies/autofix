import { handleDrainRequest } from "@/lib/jobs/http";

/**
 * Runs due jobs now (`Authorization: Bearer CRON_SECRET`). Optional JSON body
 * `{ "kinds": ["reminders.send"], "budgetMs": 20000 }` (budget 1–50 s, default 20 s). For an external
 * scheduler on Vercel Hobby, or to clear the queue after a deploy. Answers with counts only.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleDrainRequest(request);
}
