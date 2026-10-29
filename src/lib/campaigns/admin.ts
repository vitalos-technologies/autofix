import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { maskEmail, maskMobile } from "@/lib/booking-flow/copy";
import { parseCampaignConsentBasis, type CampaignConsentBasis } from "@/lib/consent/offers";
import { parseStoredSegment, type CampaignChannel, type CampaignSegment } from "./segment";
import { isCampaignStarter, type CampaignStarter } from "./templates";

// Reads for the Campaigns pages (P5.5). Every function takes the member's RLS client for the selected
// garage (getAdminContext().client, x-garage-id) and also filters on the garage id. The audience
// preview and the results are security-definer functions scoped to the selected garage in SQL
// (preview_campaign_audience(), campaign_results()). Contact details leave this module masked.

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type Campaign = {
  id: string;
  name: string;
  starter: CampaignStarter | null;
  segment: CampaignSegment;
  template: string;
  emailSubject: string;
  emailTemplate: string | null;
  serviceId: string | null;
  status: CampaignStatus;
  sendAt: string | null;
  recipients: number | null;
  createdAt: string;
  finishedAt: string | null;
};

export type CampaignResults = {
  recipients: number;
  scheduled: number;
  sent: number;
  delivered: number;
  opened: number;
  failed: number;
  skipped: number;
  bookings: number;
  pence: number;
};

export const EMPTY_RESULTS: CampaignResults = { recipients: 0, scheduled: 0, sent: 0, delivered: 0, opened: 0, failed: 0, skipped: 0, bookings: 0, pence: 0 };

type CampaignRow = {
  id: string;
  name: string;
  starter: string | null;
  segment: unknown;
  template: string;
  email_subject: string;
  email_template: string | null;
  service_id: string | null;
  status: string;
  send_at: string | null;
  recipients: number | null;
  created_at: string;
  finished_at: string | null;
};

const CAMPAIGN_COLUMNS = "id,name,starter,segment,template,email_subject,email_template,service_id,status,send_at,recipients,created_at,finished_at";

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    starter: isCampaignStarter(row.starter) ? row.starter : null,
    segment: parseStoredSegment(row.segment),
    template: row.template,
    emailSubject: row.email_subject,
    emailTemplate: row.email_template,
    serviceId: row.service_id,
    status: (CAMPAIGN_STATUSES as readonly string[]).includes(row.status) ? (row.status as CampaignStatus) : "draft",
    sendAt: row.send_at,
    recipients: row.recipients,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** The garage's campaigns, newest first. `null` when they cannot be read. */
export async function loadCampaigns(client: SupabaseClient, garageId: string): Promise<Campaign[] | null> {
  const { data, error } = await client.from("campaigns").select(CAMPAIGN_COLUMNS).eq("garage_id", garageId).order("created_at", { ascending: false }).limit(200);
  if (error || !data) return null;
  return (data as CampaignRow[]).map(toCampaign);
}

/** One campaign, `null` when it is not this garage's (or cannot be read). */
export async function loadCampaign(client: SupabaseClient, garageId: string, id: string): Promise<Campaign | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await client.from("campaigns").select(CAMPAIGN_COLUMNS).eq("garage_id", garageId).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return toCampaign(data as CampaignRow);
}

type ResultRow = {
  campaign_id: string;
  recipients: number;
  scheduled: number;
  sent: number;
  delivered: number;
  opened: number;
  failed: number;
  skipped: number;
  bookings: number;
  pence: number | string;
};

/** Results per campaign id (campaign_results()). `null` when they cannot be read. */
export async function loadCampaignResults(client: SupabaseClient, campaignId?: string): Promise<Map<string, CampaignResults> | null> {
  const { data, error } = await client.rpc("campaign_results", { p_campaign_id: campaignId ?? null });
  if (error || !Array.isArray(data)) return null;
  return new Map(
    (data as ResultRow[]).map((row) => [
      row.campaign_id,
      {
        recipients: Number(row.recipients) || 0,
        scheduled: Number(row.scheduled) || 0,
        sent: Number(row.sent) || 0,
        delivered: Number(row.delivered) || 0,
        opened: Number(row.opened) || 0,
        failed: Number(row.failed) || 0,
        skipped: Number(row.skipped) || 0,
        bookings: Number(row.bookings) || 0,
        pence: Number(row.pence) || 0,
      },
    ]),
  );
}

/** All campaigns' results added up. */
export function totalResults(results: Iterable<CampaignResults>): CampaignResults {
  const total = { ...EMPTY_RESULTS };
  for (const item of results) {
    for (const key of Object.keys(total) as Array<keyof CampaignResults>) total[key] += item[key];
  }
  return total;
}

export type AudienceRow = {
  customerId: string;
  name: string;
  contact: string;
  channel: CampaignChannel;
  registration: string;
  vehicle: string;
  lastVisit: string | null;
  /** Why the campaign may go to them: they ticked offers, or soft opt-in. */
  basis: CampaignConsentBasis;
};

/** `offersTotal` of `total` ticked the offers box; the rest are existing customers under the soft opt-in. */
export type AudiencePreview = { total: number; offersTotal: number; rows: AudienceRow[] };

type AudienceDbRow = {
  total: number;
  offers_total: number | null;
  customer_id: string | null;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  channel: string | null;
  registration: string | null;
  make: string | null;
  model: string | null;
  last_visit: string | null;
  consent_basis: string | null;
};

function contactHint(channel: string | null, phone: string | null, email: string | null) {
  if (channel === "email" && email) return maskEmail(email);
  return phone ? maskMobile(phone) : "";
}

export type PreviewError = "plan_required" | "mot_disabled" | "not_allowed" | "failed";

/** The live count and the first `limit` customers a segment matches, contact details masked. */
export async function previewAudience(client: SupabaseClient, segment: CampaignSegment, limit = 20): Promise<{ ok: true; preview: AudiencePreview } | { ok: false; error: PreviewError }> {
  const { data, error } = await client.rpc("preview_campaign_audience", { p_segment: segment, p_limit: limit });
  if (error) {
    const message = error.message ?? "";
    if (message.startsWith("PLAN_REQUIRED")) return { ok: false, error: "plan_required" };
    if (message.startsWith("MOT_DISABLED")) return { ok: false, error: "mot_disabled" };
    if (error.code === "42501") return { ok: false, error: "not_allowed" };
    return { ok: false, error: "failed" };
  }
  const rows = (Array.isArray(data) ? data : []) as AudienceDbRow[];
  return {
    ok: true,
    preview: {
      total: Number(rows[0]?.total ?? 0),
      offersTotal: Number(rows[0]?.offers_total ?? 0),
      rows: rows
        .filter((row) => row.customer_id)
        .map((row) => ({
          customerId: row.customer_id!,
          name: row.customer_name ?? "Customer",
          contact: contactHint(row.channel, row.phone, row.email),
          channel: (row.channel === "email" || row.channel === "whatsapp" ? row.channel : "sms") as CampaignChannel,
          registration: row.registration ?? "",
          vehicle: [row.make, row.model].filter(Boolean).join(" "),
          lastVisit: row.last_visit,
          basis: parseCampaignConsentBasis(row.consent_basis) ?? "offers",
        })),
    },
  };
}

export type RecipientRow = {
  id: string;
  customerId: string;
  name: string;
  contact: string;
  registration: string;
  channel: CampaignChannel;
  status: string;
  skipReason: string | null;
  opened: boolean;
  booked: boolean;
};

type RecipientDbRow = {
  id: string;
  customer_id: string;
  channel: string;
  status: string;
  skip_reason: string | null;
  opened_at: string | null;
  booking_id: string | null;
  customers: { name: string | null; phone: string | null; email: string | null } | Array<{ name: string | null; phone: string | null; email: string | null }> | null;
  vehicles: { registration: string | null } | Array<{ registration: string | null }> | null;
};

function first<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

/** A campaign's recipients (first 200 by name), contact details masked. `null` when they cannot be read. */
export async function loadRecipients(client: SupabaseClient, garageId: string, campaignId: string): Promise<RecipientRow[] | null> {
  const { data, error } = await client
    .from("campaign_sends")
    .select("id,customer_id,channel,status,skip_reason,opened_at,booking_id,customers(name,phone,email),vehicles(registration)")
    .eq("garage_id", garageId)
    .eq("campaign_id", campaignId)
    .limit(200);
  if (error || !data) return null;
  return (data as RecipientDbRow[])
    .map((row) => {
      const customer = first(row.customers);
      return {
        id: row.id,
        customerId: row.customer_id,
        name: customer?.name ?? "Customer",
        contact: contactHint(row.channel, customer?.phone ?? null, customer?.email ?? null),
        registration: first(row.vehicles)?.registration ?? "",
        channel: (row.channel === "email" || row.channel === "whatsapp" ? row.channel : "sms") as CampaignChannel,
        status: row.status,
        skipReason: row.skip_reason,
        opened: Boolean(row.opened_at),
        booked: Boolean(row.booking_id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
}

export type CampaignService = { id: string; name: string; isMot: boolean };

/** The garage's services (for the history filter and the link), MOT ones only while MOTs are on. */
export async function loadCampaignServices(client: SupabaseClient, garageId: string, motEnabled: boolean): Promise<CampaignService[]> {
  const { data, error } = await client.from("services").select("id,name,is_mot,sort").eq("garage_id", garageId).is("deleted_at", null).order("sort").order("name");
  if (error || !data) return [];
  return (data as Array<{ id: string; name: string; is_mot: boolean | null }>)
    .map((row) => ({ id: row.id, name: row.name, isMot: Boolean(row.is_mot) }))
    .filter((service) => motEnabled || !service.isMot);
}
