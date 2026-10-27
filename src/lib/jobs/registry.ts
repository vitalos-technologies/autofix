import "server-only";

import { callsTextBackHandler } from "./handlers/calls-text-back";
import { customersEnrichHandler } from "./handlers/customers-enrich";
import { domainsCheckHandler } from "./handlers/domains-check";
import { messagesReplyHandler } from "./handlers/messages-reply";
import { motRefreshHandler } from "./handlers/mot-refresh";
import { notificationsBookingHandler } from "./handlers/notifications-booking";
import { remindersScheduleHandler } from "./handlers/reminders-schedule";
import { remindersSendHandler } from "./handlers/reminders-send";
import { retentionHandler } from "./handlers/retention";
import { platformCloseImpersonationsHandler } from "@/lib/platform/jobs";
import { JOB_KINDS, type JobDefinition, type JobHandler, type JobKind } from "./types";

// The typed handler registry. Order is JOB_KINDS: time-critical sends before
// housekeeping, and the DVSA-bound work (imports, the MOT refresh) last so it
// never starves them.

const HANDLERS: Record<JobKind, { handler: JobHandler; timeoutMs: number }> = {
  "reminders.schedule": { handler: remindersScheduleHandler, timeoutMs: 15_000 },
  "reminders.send": { handler: remindersSendHandler, timeoutMs: 18_000 },
  "notifications.booking": { handler: notificationsBookingHandler, timeoutMs: 15_000 },
  "calls.text_back": { handler: callsTextBackHandler, timeoutMs: 12_000 },
  "messages.reply": { handler: messagesReplyHandler, timeoutMs: 12_000 },
  "domains.check": { handler: domainsCheckHandler, timeoutMs: 18_000 },
  retention: { handler: retentionHandler, timeoutMs: 18_000 },
  "platform.close_impersonations": { handler: platformCloseImpersonationsHandler, timeoutMs: 10_000 },
  "customers.enrich": { handler: customersEnrichHandler, timeoutMs: 18_000 },
  "mot.refresh": { handler: motRefreshHandler, timeoutMs: 18_000 },
};

export const JOB_DEFINITIONS: readonly JobDefinition[] = JOB_KINDS.map((kind) => ({ kind, ...HANDLERS[kind] }));
