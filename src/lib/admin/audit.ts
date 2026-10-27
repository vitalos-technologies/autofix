import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";

export type AdminAuditEntry = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  detail?: Record<string, unknown>;
};

/**
 * Appends to `admin_audit_log` for one garage. Staff have no insert grant on
 * the log, so it is written with the service role and an explicit garage_id
 * (the garage the actor is working in, taken from the validated admin context
 * or the stored record, never from the request).
 */
export async function recordAdminAudit(garageId: string, entry: AdminAuditEntry, client: SupabaseClient | null = createAdminClient()) {
  if (!client) return false;
  const { error } = await client.from("admin_audit_log").insert({
    garage_id: garageId,
    actor_id: entry.actorId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    detail: entry.detail ?? {},
  });
  return !error;
}

/**
 * Account-level security events (sign-in protection, MFA, trusted devices,
 * password changes) belong to the user, not one garage: every garage the user
 * works for gets a copy, as `public.audit_user_security_event()` does in SQL.
 * A user with no membership has no garage audit log, so nothing is written.
 */
export async function recordUserSecurityEvent(
  userId: string,
  action: string,
  detail: Record<string, unknown> = {},
  entity: { type?: string; id?: string } = {},
  client: SupabaseClient | null = createAdminClient(),
) {
  if (!client) return false;
  const { data, error } = await client.from("garage_members").select("garage_id").eq("user_id", userId);
  if (error) return false;
  const garageIds = [...new Set((data ?? []).map((row) => String(row.garage_id)))];
  if (!garageIds.length) return true;
  const { error: insertError } = await client.from("admin_audit_log").insert(garageIds.map((garageId) => ({
    garage_id: garageId,
    actor_id: userId,
    action,
    entity_type: entity.type ?? "admin_security",
    entity_id: entity.id ?? userId,
    detail,
  })));
  return !insertError;
}
