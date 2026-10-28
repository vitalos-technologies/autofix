import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requesterIp } from "@/lib/booking-engine/http";
import { BOOKING_STATE_COOKIE, bookingStateCookieOptions, sealBookingSession } from "@/lib/booking-engine/state";
import type { BookingDraft } from "@/lib/booking-engine/types";
import { databaseError } from "@/lib/jobs/types";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { ReminderLinkProblem } from "@/lib/reminders/link-problems";
import { hashReminderLinkToken, isReminderLinkToken } from "@/lib/reminders/link-token";
import { createSupabaseReminderLinkRepo, type LinkService } from "@/lib/reminders/open-link";
import { createAdminClient } from "@/lib/supabase/server";
import { getHostGarage, type Garage } from "@/lib/tenancy/garage";
import { toIsoDate } from "@/lib/vehicle/mot";

// `/c/{token}` on the garage host (P5.5): the link in a campaign message opens
// the booking page with the car (and the campaign's service, when it has one)
// filled in, exactly like a reminder link (/r/{token}, P3.9). The token is
// hashed and looked up among the host garage's campaign sends that went out;
// unknown, another garage's or expired (30 days) tokens open nothing. The
// first open is recorded (`opened_at`, the "opened" figure). The sealed draft
// carries `campaignSendId`; after create_booking() succeeds the booking flow
// calls attribute_campaign_booking(), which credits the booking only when it
// is for the send's own customer and car. The answer is a 303 with a
// relative Location, so the token never stays in the address bar or a
// Referer; problems land on the reminder link page (/r?link=…), whose wording
// is about "this link".

const SENT_STATUSES = new Set(["sending", "sent", "delivered", "failed"]);
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } as const;

export type LinkedCampaignSend = {
  id: string;
  status: string;
  linkExpiresAt: string | null;
  openedAt: string | null;
  serviceId: string | null;
  vehicle: { registration: string; make: string | null; model: string | null; motExpiry: string | null } | null;
};

export interface CampaignLinkRepo {
  findByTokenHash(garageId: string, tokenHash: string): Promise<LinkedCampaignSend | null>;
  markOpened(garageId: string, sendId: string, at: Date): Promise<void>;
  listOnlineServices(garageId: string): Promise<LinkService[]>;
}

export type OpenedCampaignLink = { ok: true; draft: BookingDraft; next: "/time" | "/service" } | { ok: false; problem: "invalid" | "expired" };

function trimmed(value: string | null | undefined, max: number) {
  const clean = value?.trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, max) : undefined;
}

export async function openCampaignLink(input: {
  garage: Pick<Garage, "id" | "motEnabled">;
  token: string;
  repo: CampaignLinkRepo;
  now?: Date;
}): Promise<OpenedCampaignLink> {
  const now = input.now ?? new Date();
  if (!isReminderLinkToken(input.token)) return { ok: false, problem: "invalid" };

  const send = await input.repo.findByTokenHash(input.garage.id, hashReminderLinkToken(input.token));
  if (!send || !SENT_STATUSES.has(send.status) || !send.vehicle) return { ok: false, problem: "invalid" };
  const expires = send.linkExpiresAt ? Date.parse(send.linkExpiresAt) : Number.NaN;
  if (!Number.isFinite(expires) || expires <= now.getTime()) return { ok: false, problem: "expired" };

  if (!send.openedAt) await input.repo.markOpened(input.garage.id, send.id, now);

  const registration = send.vehicle.registration.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{2,8}$/.test(registration)) return { ok: false, problem: "invalid" };
  const vehicle: NonNullable<BookingDraft["vehicle"]> = { registration };
  const make = trimmed(send.vehicle.make, 80);
  const model = trimmed(send.vehicle.model, 120);
  if (make) vehicle.make = make;
  if (model) vehicle.model = model;
  const motExpiry = input.garage.motEnabled ? toIsoDate(send.vehicle.motExpiry) : undefined;
  if (motExpiry) vehicle.motExpiry = motExpiry;

  const draft: BookingDraft = { v: 1, garageId: input.garage.id, idempotencyKey: randomUUID(), vehicle, campaignSendId: send.id };
  if (!send.serviceId) return { ok: true, draft, next: "/service" };
  const service = (await input.repo.listOnlineServices(input.garage.id)).find((item) => item.id === send.serviceId);
  // A service that is offline now, an MOT while MOTs are off, or a mobile-only one (needs the postcode): pick on the service step.
  if (!service || (service.isMot && !input.garage.motEnabled)) return { ok: true, draft, next: "/service" };
  draft.serviceId = service.id;
  if (service.locationMode === "mobile") return { ok: true, draft, next: "/service" };
  draft.locationMode = "workshop";
  return { ok: true, draft, next: "/time" };
}

type SendRow = {
  id: string;
  status: string;
  link_expires_at: string | null;
  opened_at: string | null;
  campaigns: { service_id: string | null } | Array<{ service_id: string | null }> | null;
  vehicles: { registration: string; make: string | null; model: string | null; mot_expiry: string | null } | Array<{ registration: string; make: string | null; model: string | null; mot_expiry: string | null }> | null;
};

function first<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function createSupabaseCampaignLinkRepo(db: SupabaseClient): CampaignLinkRepo {
  const services = createSupabaseReminderLinkRepo(db);
  return {
    async findByTokenHash(garageId, tokenHash) {
      const { data, error } = await db
        .from("campaign_sends")
        .select("id,status,link_expires_at,opened_at,campaigns(service_id),vehicles(registration,make,model,mot_expiry)")
        .eq("garage_id", garageId)
        .eq("link_token_hash", tokenHash)
        .maybeSingle();
      if (error) throw databaseError("campaign_sends.by_link", error);
      if (!data) return null;
      const row = data as SendRow;
      const vehicle = first(row.vehicles);
      return {
        id: row.id,
        status: row.status,
        linkExpiresAt: row.link_expires_at,
        openedAt: row.opened_at,
        serviceId: first(row.campaigns)?.service_id ?? null,
        vehicle: vehicle ? { registration: vehicle.registration, make: vehicle.make, model: vehicle.model, motExpiry: vehicle.mot_expiry } : null,
      };
    },

    async markOpened(garageId, sendId, at) {
      const { error } = await db.from("campaign_sends").update({ opened_at: at.toISOString() }).eq("garage_id", garageId).eq("id", sendId).is("opened_at", null);
      if (error) throw databaseError("campaign_sends.opened", error);
    },

    listOnlineServices: (garageId) => services.listOnlineServices(garageId),
  };
}

function seeOther(path: string) {
  return new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: path } });
}

function problem(kind: ReminderLinkProblem) {
  return seeOther(`/r?link=${kind}`);
}

export type CampaignLinkRouteDeps = {
  hostGarage?: () => Promise<Garage | null>;
  repo?: () => CampaignLinkRepo | null;
  rateLimit?: typeof consumeRateLimit;
  now?: () => Date;
};

/** GET /c/{token} (rewritten to /_site/[garageId]/c/[token]). */
export async function handleCampaignLinkRequest(request: Request, params: { garageId: string; token: string }, deps: CampaignLinkRouteDeps = {}): Promise<Response> {
  let garage: Garage | null;
  try {
    garage = await (deps.hostGarage ?? getHostGarage)();
  } catch {
    return problem("unavailable");
  }
  if (!garage || garage.id !== params.garageId) return new NextResponse("Not found", { status: 404, headers: HEADERS });

  if (!(await (deps.rateLimit ?? consumeRateLimit)(`${garage.id}:${requesterIp(request)}`, "campaign_link", 30, 600))) return problem("limited");

  const repo = deps.repo
    ? deps.repo()
    : (() => {
        const db = createAdminClient();
        return db ? createSupabaseCampaignLinkRepo(db) : null;
      })();
  if (!repo) return problem("unavailable");

  try {
    const opened = await openCampaignLink({ garage, token: params.token, repo, now: (deps.now ?? (() => new Date()))() });
    if (!opened.ok) return problem(opened.problem);
    const response = seeOther(opened.next);
    response.cookies.set(BOOKING_STATE_COOKIE, sealBookingSession(opened.draft), bookingStateCookieOptions());
    return response;
  } catch {
    return problem("unavailable");
  }
}

/**
 * After create_booking() succeeded for a draft from a campaign link: credit the booking to the send
 * (attribute_campaign_booking(), service role; the database checks the send went out and is for the
 * booking's own customer and car). Never throws: a booking is never undone for its figures.
 */
export async function attributeCampaignBooking(garageId: string, campaignSendId: string, bookingId: string, db: SupabaseClient | null = createAdminClient()): Promise<boolean> {
  if (!db) return false;
  try {
    const { data, error } = await db.rpc("attribute_campaign_booking", { p_garage_id: garageId, p_campaign_send_id: campaignSendId, p_booking_id: bookingId });
    return !error && data === true;
  } catch {
    return false;
  }
}
