import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChecklistItem } from "./checklist";
import {
  HEALTH_CHECK_ITEM_SELECT,
  HEALTH_CHECK_MEDIA_SELECT,
  HEALTH_CHECK_SELECT,
  toChecklistItem,
  toHealthCheckMedia,
  toHealthCheckSummary,
  type HealthCheckItemRow,
  type HealthCheckMedia,
  type HealthCheckMediaRow,
  type HealthCheckRow,
  type HealthCheckSummary,
} from "./view";

// Reads for the admin pages (the member's RLS client: the selected garage only) and the customer
// page (the service role, after the signed session named the garage and check). Media is served
// only through short-lived signed URLs: 10 minutes in the admin (signed with the member's client,
// so the storage policy applies), 15 minutes on the customer page.

export const HEALTH_CHECK_BUCKET = "health-check-media";
export const ADMIN_MEDIA_URL_SECONDS = 10 * 60;
export const CUSTOMER_MEDIA_URL_SECONDS = 15 * 60;

export class HealthCheckDataError extends Error {
  constructor(what: string) {
    super(`Could not load ${what}`);
    this.name = "HealthCheckDataError";
  }
}

export type HealthCheckDetail = HealthCheckSummary & { items: ChecklistItem[]; media: HealthCheckMedia[] };

export async function listHealthChecks(client: SupabaseClient, limit = 50): Promise<HealthCheckSummary[]> {
  const { data, error } = await client.from("health_checks").select(HEALTH_CHECK_SELECT).order("updated_at", { ascending: false }).limit(limit);
  if (error) throw new HealthCheckDataError("health checks");
  return ((data ?? []) as unknown as HealthCheckRow[]).map(toHealthCheckSummary);
}

async function signMedia(client: SupabaseClient, rows: HealthCheckMediaRow[], seconds: number): Promise<HealthCheckMedia[]> {
  if (rows.length === 0) return [];
  const { data } = await client.storage.from(HEALTH_CHECK_BUCKET).createSignedUrls(rows.map((row) => row.object_path), seconds);
  const byPath = new Map((data ?? []).flatMap((entry) => (entry.path && entry.signedUrl ? [[entry.path, entry.signedUrl] as const] : [])));
  return rows.map((row) => toHealthCheckMedia(row, byPath.get(row.object_path) ?? null));
}

async function loadDetail(client: SupabaseClient, garageId: string | null, id: string, mediaSeconds: number): Promise<HealthCheckDetail | null> {
  let checkQuery = client.from("health_checks").select(HEALTH_CHECK_SELECT).eq("id", id);
  let itemQuery = client.from("health_check_items").select(HEALTH_CHECK_ITEM_SELECT).eq("check_id", id);
  let mediaQuery = client.from("health_check_media").select(HEALTH_CHECK_MEDIA_SELECT).eq("check_id", id).eq("uploaded", true);
  if (garageId) {
    checkQuery = checkQuery.eq("garage_id", garageId);
    itemQuery = itemQuery.eq("garage_id", garageId);
    mediaQuery = mediaQuery.eq("garage_id", garageId);
  }
  const [check, items, media] = await Promise.all([
    checkQuery.maybeSingle(),
    itemQuery.order("position", { ascending: true }).order("created_at", { ascending: true }),
    mediaQuery.order("created_at", { ascending: true }),
  ]);
  if (check.error || items.error || media.error) throw new HealthCheckDataError("the health check");
  if (!check.data) return null;
  return {
    ...toHealthCheckSummary(check.data as unknown as HealthCheckRow),
    items: ((items.data ?? []) as HealthCheckItemRow[]).map(toChecklistItem),
    media: await signMedia(client, (media.data ?? []) as HealthCheckMediaRow[], mediaSeconds),
  };
}

/** One check for the admin editor (RLS client), or null when it isn't this garage's. */
export function loadHealthCheck(client: SupabaseClient, id: string): Promise<HealthCheckDetail | null> {
  return loadDetail(client, null, id, ADMIN_MEDIA_URL_SECONDS);
}

/** The check for the customer page (service role, scoped to the host's garage). */
export function loadCustomerHealthCheck(db: SupabaseClient, garageId: string, checkId: string): Promise<HealthCheckDetail | null> {
  return loadDetail(db, garageId, checkId, CUSTOMER_MEDIA_URL_SECONDS);
}

export type BookingHealthCheck = Pick<HealthCheckSummary, "id" | "status" | "approvedTotalPence" | "firstViewedAt" | "respondedAt" | "invoiceId">;

/** The booking's health check, if it has one (booking page). Null on any error: the page still renders. */
export async function loadBookingHealthCheck(client: SupabaseClient, bookingId: string): Promise<BookingHealthCheck | null> {
  const { data, error } = await client
    .from("health_checks")
    .select("id,status,approved_total_pence,first_viewed_at,responded_at,invoice_id")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; status: string; approved_total_pence: number | string | null; first_viewed_at: string | null; responded_at: string | null; invoice_id: string | null };
  return {
    id: row.id,
    status: row.status === "sent" || row.status === "responded" ? row.status : "draft",
    approvedTotalPence: Number(row.approved_total_pence ?? 0) || 0,
    firstViewedAt: row.first_viewed_at,
    respondedAt: row.responded_at,
    invoiceId: row.invoice_id,
  };
}

export type RecentApproval = { id: string; bookingId: string; reference: string | null; customerName: string | null; registration: string | null; approvedTotalPence: number; respondedAt: string };

/** Checks the customers answered since `since` with work approved (Today). Empty on any error. */
export async function loadRecentApprovals(client: SupabaseClient, since: Date, limit = 5): Promise<RecentApproval[]> {
  const { data, error } = await client
    .from("health_checks")
    .select(HEALTH_CHECK_SELECT)
    .eq("status", "responded")
    .gt("approved_total_pence", 0)
    .gte("responded_at", since.toISOString())
    .order("responded_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return ((data ?? []) as unknown as HealthCheckRow[]).map(toHealthCheckSummary).map((check) => ({
    id: check.id,
    bookingId: check.bookingId,
    reference: check.reference,
    customerName: check.customerName,
    registration: check.registration,
    approvedTotalPence: check.approvedTotalPence,
    respondedAt: check.respondedAt ?? check.updatedAt,
  }));
}
