import { handleReminderLinkRequest } from "@/lib/reminders/link-route";

/**
 * Reminder links (`/r/{token}` on the garage host, P3.9): prefill the booking draft from the
 * reminder and send the customer on to `/time` (or `/service`). The token never stays in the URL.
 */
export async function GET(request: Request, context: { params: Promise<{ garageId: string; token: string }> }) {
  return handleReminderLinkRequest(request, await context.params);
}
