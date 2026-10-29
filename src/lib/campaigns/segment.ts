// Campaign segments (P5.5): who a campaign goes to. Pure and client-safe: the segment builder, the
// server actions and the tests share it. The database checks the same shape
// (campaign_segment_problem() in supabase/migrations/20261029000500_campaigns.sql) and evaluates it
// (campaign_audience()); this file never decides who is in a segment, it only builds and describes it.
//
// Every segment is already limited to customers campaigns may go to (offers consent or the soft
// opt-in route, campaign_consent_basis(); not opted out, not anonymised), an address for their
// channel and a car. The filters narrow that down.

import { z } from "zod";

export const CAMPAIGN_CHANNELS = ["sms", "whatsapp", "email"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const SERVICE_HISTORIES = ["had", "never"] as const;
export type ServiceHistory = (typeof SERVICE_HISTORIES)[number];

export const MAX_CAR_AGE = 60;
export const NOT_SEEN_CHOICES = [3, 6, 12, 18, 24, 36] as const;

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export const CHANNEL_NAMES: Record<CampaignChannel, string> = { sms: "Text", whatsapp: "WhatsApp", email: "Email" };

export type CampaignSegment = {
  car_age_min?: number;
  car_age_max?: number;
  mot_months?: number[];
  not_seen_months?: number;
  service_id?: string;
  service_history?: ServiceHistory;
  channels?: CampaignChannel[];
};

const wholeYears = z.number().int().min(0).max(MAX_CAR_AGE);

export const campaignSegmentSchema = z
  .object({
    car_age_min: wholeYears.optional(),
    car_age_max: wholeYears.optional(),
    mot_months: z
      .array(z.number().int().min(1).max(12))
      .max(12)
      .refine((months) => new Set(months).size === months.length, "Pick each month once.")
      .optional(),
    not_seen_months: z.number().int().min(1).max(120).optional(),
    service_id: z.string().uuid().optional(),
    service_history: z.enum(SERVICE_HISTORIES).optional(),
    channels: z
      .array(z.enum(CAMPAIGN_CHANNELS))
      .min(1)
      .max(3)
      .refine((channels) => new Set(channels).size === channels.length)
      .optional(),
  })
  .strict()
  .refine((segment) => segment.car_age_min === undefined || segment.car_age_max === undefined || segment.car_age_min <= segment.car_age_max, {
    message: "The youngest age can't be more than the oldest.",
    path: ["car_age_max"],
  })
  .refine((segment) => (segment.service_id === undefined) === (segment.service_history === undefined), {
    message: "Choose a service for the history filter.",
    path: ["service_id"],
  });

export type SegmentField = "carAge" | "motMonths" | "notSeen" | "service" | "channels";

export type ParsedSegment = { ok: true; segment: CampaignSegment } | { ok: false; fieldErrors: Partial<Record<SegmentField, string>> };

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function wholeNumber(raw: string): number | null | "bad" {
  if (!raw) return null;
  if (!/^\d{1,3}$/.test(raw)) return "bad";
  return Number(raw);
}

/**
 * The segment builder's fields as a segment: `carAgeMin`/`carAgeMax` (years), `motMonth` (repeated,
 * 1-12; ignored unless the garage does MOTs), `notSeen` (months or empty), `history` (`any`, `had`,
 * `never`) with `historyService`, and `channel` (repeated; all three or none = no filter).
 */
export function segmentFromForm(formData: FormData, options: { motEnabled: boolean }): ParsedSegment {
  const fieldErrors: Partial<Record<SegmentField, string>> = {};
  const segment: CampaignSegment = {};

  const min = wholeNumber(text(formData, "carAgeMin"));
  const max = wholeNumber(text(formData, "carAgeMax"));
  if (min === "bad" || max === "bad" || (typeof min === "number" && min > MAX_CAR_AGE) || (typeof max === "number" && max > MAX_CAR_AGE)) {
    fieldErrors.carAge = `Use whole years from 0 to ${MAX_CAR_AGE}.`;
  } else if (typeof min === "number" && typeof max === "number" && min > max) {
    fieldErrors.carAge = "The youngest age can't be more than the oldest.";
  } else {
    if (typeof min === "number") segment.car_age_min = min;
    if (typeof max === "number") segment.car_age_max = max;
  }

  if (options.motEnabled) {
    const months = [...new Set(formData.getAll("motMonth").map((value) => Number(value)))];
    if (months.some((month) => !Number.isInteger(month) || month < 1 || month > 12)) fieldErrors.motMonths = "Pick months from the list.";
    else if (months.length > 0) segment.mot_months = months.sort((a, b) => a - b);
  }

  const notSeen = wholeNumber(text(formData, "notSeen"));
  if (notSeen === "bad" || (typeof notSeen === "number" && (notSeen < 1 || notSeen > 120))) fieldErrors.notSeen = "Choose how long since their last visit.";
  else if (typeof notSeen === "number") segment.not_seen_months = notSeen;

  const history = text(formData, "history");
  if (history === "had" || history === "never") {
    const serviceId = text(formData, "historyService");
    if (!z.string().uuid().safeParse(serviceId).success) fieldErrors.service = "Choose the service.";
    else {
      segment.service_id = serviceId;
      segment.service_history = history;
    }
  } else if (history && history !== "any") {
    fieldErrors.service = "Choose a service history option.";
  }

  const channels = [...new Set(formData.getAll("channel").map(String))];
  if (channels.some((channel) => !(CAMPAIGN_CHANNELS as readonly string[]).includes(channel))) fieldErrors.channels = "Choose text, WhatsApp or email.";
  else if (channels.length > 0 && channels.length < CAMPAIGN_CHANNELS.length) segment.channels = channels as CampaignChannel[];

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  const parsed = campaignSegmentSchema.safeParse(segment);
  if (!parsed.success) return { ok: false, fieldErrors: { carAge: "Check the filters." } };
  return { ok: true, segment: parsed.data };
}

/** A stored segment (jsonb) as a segment, or `{}` when it does not parse (shown as "everyone"). */
export function parseStoredSegment(value: unknown): CampaignSegment {
  const parsed = campaignSegmentSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

function listWords(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The segment in words, one line per filter ("Cars 3 to 8 years old", "MOT due in March"). */
export function describeSegment(segment: CampaignSegment, options: { serviceName?: (id: string) => string | undefined } = {}): string[] {
  const lines: string[] = [];
  const { car_age_min: min, car_age_max: max } = segment;
  if (min !== undefined && max !== undefined) lines.push(min === max ? `Cars ${min} ${min === 1 ? "year" : "years"} old` : `Cars ${min} to ${max} years old`);
  else if (min !== undefined) lines.push(`Cars at least ${min} ${min === 1 ? "year" : "years"} old`);
  else if (max !== undefined) lines.push(`Cars up to ${max} ${max === 1 ? "year" : "years"} old`);
  if (segment.mot_months?.length) lines.push(`MOT due in ${listWords(segment.mot_months.map((month) => MONTH_NAMES[month - 1]!))}`);
  if (segment.not_seen_months) lines.push(`Not seen for ${segment.not_seen_months} months or more`);
  if (segment.service_id && segment.service_history) {
    const name = options.serviceName?.(segment.service_id) ?? "a service";
    lines.push(segment.service_history === "had" ? `Have had ${name}` : `Have never had ${name}`);
  }
  if (segment.channels?.length) lines.push(`Who hear from you by ${listWords(segment.channels.map((channel) => CHANNEL_NAMES[channel].toLowerCase()))}`);
  if (lines.length === 0) lines.push("Every customer you may send offers to");
  return lines;
}

/** Whether the segment needs MOTs switched on (MOT months). */
export function segmentUsesMot(segment: CampaignSegment) {
  return Boolean(segment.mot_months?.length);
}
