// Job payloads, one zod schema per kind. Payloads are written by server code
// only (service role) and hold ids and dates: never phone numbers,
// registrations, bodies or tokens. A payload that does not parse fails the job
// for good (it would never parse on a retry either).

import { z } from "zod";
import { permanentJobError, type JobRow } from "./types";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** No garage: fan out to every garage it applies to. With a garage: do that garage's work. */
export const remindersSchedulePayload = z.object({ garageId: uuid.optional(), today: isoDate.optional() }).strict();
export const remindersSendPayload = z.object({ garageId: uuid.optional() }).strict();
/** `after`: continue after this vehicle id (batches respect DVSA's rate limit). */
export const motRefreshPayload = z.object({ garageId: uuid.optional(), after: uuid.optional() }).strict();
export const domainsCheckPayload = z.object({}).strict();
export const retentionPayload = z.object({ garageId: uuid.optional() }).strict();
export const notificationsBookingPayload = z
  .object({
    type: z.enum(["created", "rescheduled", "cancelled"]),
    garageId: uuid,
    bookingId: uuid,
    previousStartsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
/** An automatic answer to an inbound text (HELP for now; P4.1 adds missed-call text-back). */
export const messagesReplyPayload = z.object({ garageId: uuid, inboundMessageId: uuid, kind: z.literal("help") }).strict();

export function parsePayload<T extends z.ZodType>(schema: T, payload: unknown, job?: Pick<JobRow, "garage_id">): z.infer<T> {
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) throw permanentJobError("INVALID_PAYLOAD");
  // A garage job's payload and its jobs.garage_id must agree.
  const garageId = (parsed.data as { garageId?: string }).garageId;
  if (job?.garage_id && garageId && job.garage_id !== garageId) throw permanentJobError("GARAGE_MISMATCH");
  return parsed.data;
}
