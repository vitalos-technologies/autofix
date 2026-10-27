import "server-only";

import { enqueueJob } from "@/lib/jobs/queue";

/**
 * After a reminder rule changes (switched on or off, new timing): queue `reminders.schedule` for the
 * garage so the change shows up in the plan within minutes instead of at the nightly run. Best
 * effort: a failure leaves the nightly run to do it. `claim_reminder_sends()` re-checks the rule
 * before anything is sent either way (a switched-off rule sends nothing).
 */
export async function replanReminders(garageId: string, now = new Date()): Promise<boolean> {
  try {
    await enqueueJob("reminders.schedule", { garageId }, { garageId, dedupeKey: `reminders.schedule:${garageId}:rules:${now.toISOString()}` });
    return true;
  } catch {
    return false;
  }
}
