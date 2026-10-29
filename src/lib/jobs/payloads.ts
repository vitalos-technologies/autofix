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
/** P5.5: no garage = queue one job per garage with due campaign sends; with a garage, send them. */
export const campaignsSendPayload = z.object({ garageId: uuid.optional() }).strict();
/** `after`: continue after this vehicle id (batches respect DVSA's rate limit). */
export const motRefreshPayload = z.object({ garageId: uuid.optional(), after: uuid.optional() }).strict();
export const domainsCheckPayload = z.object({}).strict();
/** P3.11: enrich a garage's imported vehicles (optionally one import's). */
export const customersEnrichPayload = z.object({ garageId: uuid.optional(), importId: uuid.optional() }).strict();
export const retentionPayload = z.object({ garageId: uuid.optional() }).strict();
/** D22: no garage = the daily platform run (texting number + every waiting garage); with a garage, that garage. `attempt` counts bounded re-queues after a stop. */
export const numbersProvisionPayload = z.object({ garageId: uuid.optional(), attempt: z.number().int().min(1).max(3).optional() }).strict();
export const notificationsBookingPayload = z
  .object({
    type: z.enum(["created", "confirmed", "rescheduled", "cancelled"]),
    garageId: uuid,
    bookingId: uuid,
    previousStartsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
/** P4.1: the text-back to a missed caller. */
export const callsTextBackPayload = z.object({ garageId: uuid, callId: uuid }).strict();
/** An automatic answer to an inbound text (HELP). */
export const messagesReplyPayload = z.object({ garageId: uuid, inboundMessageId: uuid, kind: z.literal("help") }).strict();

export function parsePayload<T extends z.ZodType>(schema: T, payload: unknown, job?: Pick<JobRow, "garage_id">): z.infer<T> {
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) throw permanentJobError("INVALID_PAYLOAD");
  // A garage job's payload and its jobs.garage_id must agree.
  const garageId = (parsed.data as { garageId?: string }).garageId;
  if (job?.garage_id && garageId && job.garage_id !== garageId) throw permanentJobError("GARAGE_MISMATCH");
  return parsed.data;
}
