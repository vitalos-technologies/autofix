import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { GARAGES_PAGE_SIZE, redactJobError, toImpersonation, type GaragePlan, type GarageStatus, type ImpersonationRow } from "@/lib/platform/policy";

// Typed wrappers over the platform_* RPCs (20261028000500_platform_admin.sql).
// Each RPC checks platform_admins and AAL2 in the database; callers pass the
// admin's own client, never the service role.

export class PlatformError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

function fail(error: { message?: string; code?: string } | null, fallback: string): never {
  const message = error?.message ?? fallback;
  const code = error?.code === "42501" ? "FORBIDDEN" : /^[A-Z_]+/.exec(message)?.[0] ?? fallback;
  throw new PlatformError(code, message);
}

export type GarageListFilters = { search?: string; status?: GarageStatus; plan?: GaragePlan; page?: number };

export type GarageListItem = {
  id: string;
  slug: string;
  name: string;
  plan: GaragePlan;
  status: GarageStatus;
  createdAt: string;
  cancelledAt: string | null;
  memberCount: number;
  bookings30d: number;
  lastBookingAt: string | null;
  domainHostname: string | null;
  domainStatus: string | null;
};

type GarageListRow = {
  id: string; slug: string; name: string; plan: GaragePlan; status: GarageStatus; created_at: string; cancelled_at: string | null;
  member_count: number; bookings_30d: number; last_booking_at: string | null; domain_hostname: string | null; domain_status: string | null;
  total_count: number;
};

export async function listGarages(client: SupabaseClient, filters: GarageListFilters = {}) {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const { data, error } = await client.rpc("platform_garages", {
    p_search: filters.search?.trim() || null,
    p_status: filters.status ?? null,
    p_plan: filters.plan ?? null,
    p_limit: GARAGES_PAGE_SIZE,
    p_offset: (page - 1) * GARAGES_PAGE_SIZE,
  });
  if (error) fail(error, "GARAGES_UNAVAILABLE");
  const rows = (data ?? []) as GarageListRow[];
  return {
    page,
    pageSize: GARAGES_PAGE_SIZE,
    total: rows[0]?.total_count ?? 0,
    garages: rows.map((row): GarageListItem => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      plan: row.plan,
      status: row.status,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      memberCount: row.member_count,
      bookings30d: row.bookings_30d,
      lastBookingAt: row.last_booking_at,
      domainHostname: row.domain_hostname,
      domainStatus: row.domain_status,
    })),
  };
}

export type GarageDetail = {
  id: string;
  slug: string;
  name: string;
  plan: GaragePlan;
  status: GarageStatus;
  timezone: string;
  mot_enabled: boolean;
  created_at: string;
  cancelled_at: string | null;
  members: { owner: number; manager: number; technician: number };
  bookings_30d: number;
  last_booking_at: string | null;
  domains: Array<{ hostname: string; kind: string; status: string; last_checked_at: string | null }>;
  impersonations: Array<{ id: string; reason: string; started_at: string; expires_at: string; ended_at: string | null; end_reason: string | null; admin: string }>;
};

export async function getGarage(client: SupabaseClient, garageId: string): Promise<GarageDetail | null> {
  const { data, error } = await client.rpc("platform_garage", { p_garage_id: garageId });
  if (error) fail(error, "GARAGE_UNAVAILABLE");
  return (data as GarageDetail | null) ?? null;
}

export async function updateGarage(client: SupabaseClient, garageId: string, change: { plan?: GaragePlan | null; status?: GarageStatus | null; reason: string }) {
  const { data, error } = await client.rpc("platform_update_garage", {
    p_garage_id: garageId,
    p_plan: change.plan ?? null,
    p_status: change.status ?? null,
    p_reason: change.reason,
  });
  if (error) fail(error, "UPDATE_FAILED");
  return data as { id: string; plan: GaragePlan; status: GarageStatus; cancelled_at: string | null };
}

export type AuditEntry = {
  id: number;
  created_at: string;
  action: string;
  target_garage_id: string | null;
  garage_name: string | null;
  entity_type: string;
  entity_id: string;
  reason: string | null;
  detail: Record<string, unknown>;
  actor_name: string;
};

export async function listAuditEntries(client: SupabaseClient, garageId: string | null, limit = 20) {
  const { data, error } = await client.rpc("platform_audit_entries", { p_garage_id: garageId, p_limit: limit });
  if (error) fail(error, "AUDIT_UNAVAILABLE");
  return (data ?? []) as AuditEntry[];
}

export async function startImpersonation(client: SupabaseClient, garageId: string, reason: string, minutes: number) {
  const { data, error } = await client.rpc("platform_start_impersonation", { p_garage_id: garageId, p_reason: reason, p_minutes: minutes });
  if (error) fail(error, "IMPERSONATION_FAILED");
  const session = toImpersonation(((data ?? []) as ImpersonationRow[])[0]);
  if (!session) throw new PlatformError("IMPERSONATION_FAILED");
  return session;
}

export async function endImpersonation(client: SupabaseClient) {
  const { data, error } = await client.rpc("platform_end_impersonation");
  if (error) fail(error, "IMPERSONATION_END_FAILED");
  return data === true;
}

export async function currentImpersonation(client: SupabaseClient) {
  const { data, error } = await client.rpc("current_impersonation");
  if (error) return null;
  return toImpersonation(((data ?? []) as ImpersonationRow[])[0]);
}

export type JobHealth = {
  generatedAt: string;
  byKind: Array<{ kind: string; status: "queued" | "running" | "done" | "failed"; count: number }>;
  oldestQueuedAt: string | null;
  expiredLocks: Array<{ id: string; kind: string; attempts: number; max_attempts: number; locked_until: string }>;
  recentFailures: Array<{ id: string; kind: string; garageId: string | null; garageName: string | null; attempts: number; maxAttempts: number; finishedAt: string; error: string }>;
  reminderSends7d: Array<{ garageId: string; garageName: string; skipped: number; failed: number }>;
};

type JobHealthRow = {
  generated_at: string;
  by_kind: JobHealth["byKind"];
  oldest_queued_at: string | null;
  expired_locks: JobHealth["expiredLocks"];
  recent_failures: Array<{ id: string; kind: string; garage_id: string | null; garage_name: string | null; attempts: number; max_attempts: number; finished_at: string; last_error: string | null }>;
  reminder_sends_7d: Array<{ garage_id: string; garage_name: string; skipped: number; failed: number }>;
};

/** Queue health with every last_error redacted; job payloads are never read. */
export async function getJobHealth(client: SupabaseClient): Promise<JobHealth> {
  const { data, error } = await client.rpc("platform_job_health");
  if (error || !data) fail(error, "HEALTH_UNAVAILABLE");
  const row = data as JobHealthRow;
  return {
    generatedAt: row.generated_at,
    byKind: row.by_kind ?? [],
    oldestQueuedAt: row.oldest_queued_at,
    expiredLocks: row.expired_locks ?? [],
    recentFailures: (row.recent_failures ?? []).map((failure) => ({
      id: failure.id,
      kind: failure.kind,
      garageId: failure.garage_id,
      garageName: failure.garage_name,
      attempts: failure.attempts,
      maxAttempts: failure.max_attempts,
      finishedAt: failure.finished_at,
      error: redactJobError(failure.last_error),
    })),
    reminderSends7d: (row.reminder_sends_7d ?? []).map((send) => ({
      garageId: send.garage_id,
      garageName: send.garage_name,
      skipped: send.skipped,
      failed: send.failed,
    })),
  };
}

export async function retryJob(client: SupabaseClient, jobId: string, reason: string) {
  const { data, error } = await client.rpc("platform_retry_job", { p_job_id: jobId, p_reason: reason });
  if (error) fail(error, "RETRY_FAILED");
  return data === true;
}
