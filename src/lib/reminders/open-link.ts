import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingDraft, ServiceLocationMode } from "@/lib/booking-engine/types";
import { databaseError } from "@/lib/jobs/types";
import type { Garage } from "@/lib/tenancy/garage";
import { toIsoDate } from "@/lib/vehicle/mot";
import type { ReminderKind } from "./compose";
import { hashReminderLinkToken, isReminderLinkToken } from "./link-token";

// `/r/{token}` (P3.9): the link in a reminder opens the booking page with the
// car and service filled in. The token is hashed and looked up among the host
// garage's reminders that went out; an unknown token, another garage's, or
// one past its 30-day expiry opens nothing. The first open is recorded
// (`opened_at`). The draft carries `reminderSendId`, which create_booking()
// credits to the reminder when the booking is for the same car and customer
// (A52). MOT facts reach the draft only while the garage has MOT switched on.

const SENT_STATUSES = new Set(["sending", "sent", "delivered", "failed"]);

export type LinkedReminder = {
  id: string;
  kind: ReminderKind;
  status: string;
  linkExpiresAt: string | null;
  openedAt: string | null;
  vehicle: { registration: string; make: string | null; model: string | null; motExpiry: string | null } | null;
};

export type LinkService = { id: string; name: string; isMot: boolean; locationMode: ServiceLocationMode; sort: number };

export interface ReminderLinkRepo {
  findByTokenHash(garageId: string, tokenHash: string): Promise<LinkedReminder | null>;
  markOpened(garageId: string, reminderId: string, at: Date): Promise<void>;
  listOnlineServices(garageId: string): Promise<LinkService[]>;
}

export type OpenedReminderLink =
  | { ok: true; draft: BookingDraft; next: "/time" | "/service" }
  | { ok: false; problem: "invalid" | "expired" };

/**
 * The service a reminder is about: the garage's online MOT service for an MOT reminder (only while
 * MOT is on), its full service for a service reminder (else the first online service with
 * "service" in its name). Review requests and garages without a match pick on the service step.
 */
export function reminderService(kind: ReminderKind, services: readonly LinkService[], motEnabled: boolean): LinkService | null {
  const ordered = [...services].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "en-GB"));
  if (kind === "mot") return motEnabled ? ordered.find((service) => service.isMot) ?? null : null;
  if (kind === "service") {
    const general = ordered.filter((service) => !service.isMot);
    return general.find((service) => /^full service$/i.test(service.name.trim()))
      ?? general.find((service) => /\bfull service\b/i.test(service.name))
      ?? general.find((service) => /\bservice\b/i.test(service.name))
      ?? null;
  }
  return null;
}

function trimmed(value: string | null | undefined, max: number) {
  const clean = value?.trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, max) : undefined;
}

export async function openReminderLink(input: {
  garage: Pick<Garage, "id" | "motEnabled">;
  token: string;
  repo: ReminderLinkRepo;
  now?: Date;
}): Promise<OpenedReminderLink> {
  const now = input.now ?? new Date();
  if (!isReminderLinkToken(input.token)) return { ok: false, problem: "invalid" };

  const reminder = await input.repo.findByTokenHash(input.garage.id, hashReminderLinkToken(input.token));
  if (!reminder || !SENT_STATUSES.has(reminder.status) || !reminder.vehicle) return { ok: false, problem: "invalid" };
  const expires = reminder.linkExpiresAt ? Date.parse(reminder.linkExpiresAt) : NaN;
  if (!Number.isFinite(expires) || expires <= now.getTime()) return { ok: false, problem: "expired" };

  if (!reminder.openedAt) await input.repo.markOpened(input.garage.id, reminder.id, now);

  const registration = reminder.vehicle.registration.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{2,8}$/.test(registration)) return { ok: false, problem: "invalid" };
  const vehicle: NonNullable<BookingDraft["vehicle"]> = { registration };
  const make = trimmed(reminder.vehicle.make, 80);
  const model = trimmed(reminder.vehicle.model, 120);
  if (make) vehicle.make = make;
  if (model) vehicle.model = model;
  const motExpiry = input.garage.motEnabled ? toIsoDate(reminder.vehicle.motExpiry) : undefined;
  if (motExpiry) vehicle.motExpiry = motExpiry;

  const draft: BookingDraft = { v: 1, garageId: input.garage.id, idempotencyKey: randomUUID(), vehicle, reminderSendId: reminder.id };
  const service = reminderService(reminder.kind, await input.repo.listOnlineServices(input.garage.id), input.garage.motEnabled);
  if (!service) return { ok: true, draft, next: "/service" };

  draft.serviceId = service.id;
  // A mobile-only service needs the postcode, which the service step asks for.
  if (service.locationMode === "mobile") return { ok: true, draft, next: "/service" };
  draft.locationMode = "workshop";
  return { ok: true, draft, next: "/time" };
}

type SendRow = {
  id: string;
  kind: ReminderKind;
  status: string;
  link_expires_at: string | null;
  opened_at: string | null;
  vehicles: { registration: string; make: string | null; model: string | null; mot_expiry: string | null } | Array<{ registration: string; make: string | null; model: string | null; mot_expiry: string | null }> | null;
};

type ServiceRow = { id: string; name: string; is_mot: boolean | null; location_mode: ServiceLocationMode; sort: number | null };

export function createSupabaseReminderLinkRepo(db: SupabaseClient): ReminderLinkRepo {
  return {
    async findByTokenHash(garageId, tokenHash) {
      const { data, error } = await db
        .from("reminder_sends")
        .select("id,kind,status,link_expires_at,opened_at,vehicles(registration,make,model,mot_expiry)")
        .eq("garage_id", garageId)
        .eq("link_token_hash", tokenHash)
        .maybeSingle();
      if (error) throw databaseError("reminder_sends.by_link", error);
      if (!data) return null;
      const row = data as SendRow;
      const vehicle = Array.isArray(row.vehicles) ? row.vehicles[0] ?? null : row.vehicles;
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        linkExpiresAt: row.link_expires_at,
        openedAt: row.opened_at,
        vehicle: vehicle ? { registration: vehicle.registration, make: vehicle.make, model: vehicle.model, motExpiry: vehicle.mot_expiry } : null,
      };
    },

    async markOpened(garageId, reminderId, at) {
      const { error } = await db
        .from("reminder_sends")
        .update({ opened_at: at.toISOString() })
        .eq("garage_id", garageId)
        .eq("id", reminderId)
        .is("opened_at", null);
      if (error) throw databaseError("reminder_sends.opened", error);
    },

    async listOnlineServices(garageId) {
      const { data, error } = await db
        .from("services")
        .select("id,name,is_mot,location_mode,sort")
        .eq("garage_id", garageId)
        .eq("online_enabled", true)
        .is("deleted_at", null);
      if (error) throw databaseError("services.online", error);
      return ((data ?? []) as ServiceRow[]).map((row) => ({
        id: row.id,
        name: row.name,
        isMot: Boolean(row.is_mot),
        locationMode: row.location_mode,
        sort: row.sort ?? 0,
      }));
    },
  };
}
