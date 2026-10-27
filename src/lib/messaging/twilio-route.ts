import "server-only";

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createSupabaseTwilioWebhookRepo } from "./twilio-webhook-repository";
import { handleTwilioWebhook, type TwilioWebhookKind } from "./twilio-webhooks";

// Route handler factory for POST /api/webhooks/twilio/{sms,whatsapp,status,voice}.
// Queued replies (HELP) are drained after the response, so Twilio gets its
// answer at once.

const REPLY_DRAIN_BUDGET_MS = 10_000;

export function twilioWebhookRoute(kind: TwilioWebhookKind) {
  return async function POST(request: Request) {
    return handleTwilioWebhook(request, kind, {
      repo: () => {
        const db = createAdminClient();
        return db ? createSupabaseTwilioWebhookRepo(db) : null;
      },
      afterResponse: (task) => {
        const run = () => task().catch(() => undefined);
        try {
          after(run);
        } catch {
          void run();
        }
      },
      drainReplies: async () => {
        const { drainJobs } = await import("@/lib/jobs/runner");
        return drainJobs({ kinds: ["messages.reply"], budgetMs: REPLY_DRAIN_BUDGET_MS });
      },
    });
  };
}
