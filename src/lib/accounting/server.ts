import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { adminUrl } from "@/lib/tenancy/urls";
import { accountingMode, getAccountingProvider } from "./providers";
import { loadConnectionTokens, mapConnectionRow, sealTokens } from "./repository";
import type { SyncEntity, SyncItemStatus } from "./sync";
import { AccountingError, isAccountingProviderId, type AccountingProviderId, type AccountingTenant, type TokenSet } from "./types";

// What the settings page and the OAuth route handlers need (P5.10). Reads for the page go through the
// member's RLS client (owners/managers only, by policy); token work uses the service role.

function serviceDb(): SupabaseClient {
  const db = createAdminClient();
  if (!db) throw new AccountingError("CONFIGURATION_REQUIRED", { detail: "Supabase service role" });
  return db;
}

export const ACCOUNTING_SETTINGS_PATH = "/app/settings/accounting";

/**
 * The OAuth redirect URI. Live providers get the registered admin-host URI
 * (https://autofix.vitalos.co.uk/api/admin/accounting/<provider>/callback); the fake, which never leaves
 * the app, comes back to the host the request came in on (local runs and e2e on another port).
 */
export function accountingCallbackUrl(provider: AccountingProviderId, requestUrl?: string): string {
  const path = `/api/admin/accounting/${provider}/callback`;
  if (requestUrl && accountingMode() === "fake") return new URL(path, requestUrl).toString();
  return adminUrl(path);
}

export type ConnectionView = {
  id: string;
  provider: AccountingProviderId;
  status: "pending" | "connected" | "needs_reconnect";
  tenantId: string | null;
  tenantName: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
};

export type SyncItemView = {
  id: string;
  entity: SyncEntity;
  status: SyncItemStatus;
  label: string;
  attempts: number;
  lastErrorCode: string | null;
  syncedAt: string | null;
  updatedAt: string;
};

export type AccountingOverview = {
  connection: ConnectionView | null;
  counts: Record<SyncItemStatus, number>;
  failed: SyncItemView[];
  recent: SyncItemView[];
  /** Past connections (disconnected) still holding history. */
  history: number;
};

type ItemRow = { id: string; entity: SyncEntity; local_id: string; status: SyncItemStatus; attempts: number; last_error_code: string | null; synced_at: string | null; updated_at: string };

function formatPounds(pence: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

/** Labels without customer data beyond what the invoice list already shows: invoice numbers and amounts. */
async function labelItems(client: SupabaseClient, garageId: string, rows: ItemRow[]): Promise<SyncItemView[]> {
  const invoiceIds = rows.filter((row) => row.entity === "invoice").map((row) => row.local_id);
  const paymentIds = rows.filter((row) => row.entity === "payment").map((row) => row.local_id);
  const customerIds = rows.filter((row) => row.entity === "contact").map((row) => row.local_id);
  const [invoices, payments, customers] = await Promise.all([
    invoiceIds.length ? client.from("invoices").select("id,invoice_number,total_pence").eq("garage_id", garageId).in("id", invoiceIds) : Promise.resolve({ data: [] }),
    paymentIds.length ? client.from("invoice_payments").select("id,amount_pence,invoice:invoices(invoice_number)").eq("garage_id", garageId).in("id", paymentIds) : Promise.resolve({ data: [] }),
    customerIds.length ? client.from("customers").select("id,name").eq("garage_id", garageId).in("id", customerIds) : Promise.resolve({ data: [] }),
  ]);
  const invoiceLabel = new Map<string, string>(((invoices.data ?? []) as { id: string; invoice_number: string | null; total_pence: number | string }[])
    .map((row) => [row.id, `Invoice ${row.invoice_number ?? ""} · ${formatPounds(Number(row.total_pence))}`.trim()]));
  const paymentLabel = new Map<string, string>(((payments.data ?? []) as { id: string; amount_pence: number | string; invoice: { invoice_number: string | null } | { invoice_number: string | null }[] | null }[])
    .map((row) => {
      const invoice = Array.isArray(row.invoice) ? row.invoice[0] : row.invoice;
      return [row.id, `Payment ${formatPounds(Number(row.amount_pence))}${invoice?.invoice_number ? ` on ${invoice.invoice_number}` : ""}`];
    }));
  const customerLabel = new Map<string, string>(((customers.data ?? []) as { id: string; name: string }[]).map((row) => [row.id, `Contact ${row.name}`]));
  return rows.map((row) => ({
    id: row.id,
    entity: row.entity,
    status: row.status,
    label: (row.entity === "invoice" ? invoiceLabel : row.entity === "payment" ? paymentLabel : customerLabel).get(row.local_id) ?? (row.entity === "contact" ? "Contact" : row.entity === "invoice" ? "Invoice" : "Payment"),
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
  }));
}

export async function loadAccountingOverview(client: SupabaseClient, garageId: string): Promise<AccountingOverview> {
  const { data: connections } = await client
    .from("accounting_connections")
    .select("id,provider,status,tenant_id,tenant_name,connected_at,last_sync_at,last_error_code")
    .eq("garage_id", garageId)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (connections ?? []) as Record<string, unknown>[];
  const active = rows.find((row) => row.status !== "disconnected" && isAccountingProviderId(row.provider));
  const connection: ConnectionView | null = active
    ? {
        id: String(active.id),
        provider: active.provider as AccountingProviderId,
        status: active.status as ConnectionView["status"],
        tenantId: (active.tenant_id as string | null) ?? null,
        tenantName: (active.tenant_name as string | null) ?? null,
        connectedAt: String(active.connected_at),
        lastSyncAt: (active.last_sync_at as string | null) ?? null,
        lastErrorCode: (active.last_error_code as string | null) ?? null,
      }
    : null;

  const counts: Record<SyncItemStatus, number> = { pending: 0, synced: 0, failed: 0 };
  let failed: SyncItemView[] = [];
  let recent: SyncItemView[] = [];
  if (connection) {
    const select = "id,entity,local_id,status,attempts,last_error_code,synced_at,updated_at";
    const [pendingCount, syncedCount, failedRows, recentRows] = await Promise.all([
      client.from("accounting_sync_items").select("id", { count: "exact", head: true }).eq("garage_id", garageId).eq("connection_id", connection.id).eq("status", "pending").neq("entity", "contact"),
      client.from("accounting_sync_items").select("id", { count: "exact", head: true }).eq("garage_id", garageId).eq("connection_id", connection.id).eq("status", "synced").neq("entity", "contact"),
      client.from("accounting_sync_items").select(select).eq("garage_id", garageId).eq("connection_id", connection.id).eq("status", "failed").order("updated_at", { ascending: false }).limit(50),
      client.from("accounting_sync_items").select(select).eq("garage_id", garageId).eq("connection_id", connection.id).neq("status", "failed").neq("entity", "contact").order("updated_at", { ascending: false }).limit(10),
    ]);
    counts.pending = pendingCount.count ?? 0;
    counts.synced = syncedCount.count ?? 0;
    const failedList = (failedRows.data ?? []) as ItemRow[];
    counts.failed = failedList.length;
    [failed, recent] = await Promise.all([labelItems(client, garageId, failedList), labelItems(client, garageId, (recentRows.data ?? []) as ItemRow[])]);
  }
  return { connection, counts, failed, recent, history: rows.filter((row) => row.status === "disconnected").length };
}

/** Saves the connection after a successful code exchange (service role; Pro is checked again in SQL). */
export async function saveConnection(input: { garageId: string; provider: AccountingProviderId; tokens: TokenSet; tenants: AccountingTenant[]; userId: string }) {
  const db = serviceDb();
  const only = input.tenants.length === 1 ? input.tenants[0] : null;
  const sealed = sealTokens(input.garageId, input.tokens);
  const { data, error } = await db.rpc("accounting_save_connection", {
    p_garage_id: input.garageId,
    p_provider: input.provider,
    p_tenant_id: only?.id ?? null,
    p_tenant_name: only?.name ?? null,
    p_scopes: input.tokens.scopes,
    p_connected_by: input.userId,
    p_access_token_ct: sealed.access_token_ct,
    p_refresh_token_ct: sealed.refresh_token_ct,
    p_expires_at: sealed.expires_at,
    p_refresh_expires_at: sealed.refresh_expires_at,
  });
  if (error) {
    if (error.message?.startsWith("PLAN_REQUIRED")) throw new AccountingError("VALIDATION", { detail: "plan" });
    throw new AccountingError("UNEXPECTED_RESPONSE", { detail: `save (${error.code ?? "unknown"})` });
  }
  return data as { id: string; status: string };
}

/** The organisations the pending connection's tokens can reach (service role). */
export async function listConnectionTenants(garageId: string): Promise<{ connectionId: string; tenants: AccountingTenant[] } | null> {
  const db = serviceDb();
  const { data } = await db.from("accounting_connections").select("id,garage_id,provider,status,tenant_id,settings").eq("garage_id", garageId).neq("status", "disconnected").maybeSingle();
  const connection = data ? mapConnectionRow(data) : null;
  if (!connection) return null;
  const tokens = await loadConnectionTokens(db, garageId, connection.id);
  if (!tokens) return { connectionId: connection.id, tenants: [] };
  try {
    return { connectionId: connection.id, tenants: await getAccountingProvider(connection.provider).listTenants(tokens) };
  } catch {
    return { connectionId: connection.id, tenants: [] };
  }
}

export async function chooseTenant(input: { garageId: string; tenantId: string; userId: string }): Promise<boolean> {
  const listed = await listConnectionTenants(input.garageId);
  const tenant = listed?.tenants.find((candidate) => candidate.id === input.tenantId);
  if (!listed || !tenant) return false;
  const { error } = await serviceDb().rpc("accounting_choose_tenant", {
    p_garage_id: input.garageId,
    p_connection_id: listed.connectionId,
    p_tenant_id: tenant.id,
    p_tenant_name: tenant.name,
    p_actor: input.userId,
  });
  return !error;
}

/** Revokes at the provider (best effort), then deletes the tokens and ends the connection. History stays. */
export async function disconnect(input: { garageId: string; userId: string }): Promise<{ revoked: boolean; ended: boolean }> {
  const db = serviceDb();
  const { data } = await db.from("accounting_connections").select("id,garage_id,provider,status,tenant_id,settings").eq("garage_id", input.garageId).neq("status", "disconnected").maybeSingle();
  const connection = data ? mapConnectionRow(data) : null;
  let revoked = false;
  if (connection) {
    try {
      const tokens = await loadConnectionTokens(db, input.garageId, connection.id);
      if (tokens) {
        await getAccountingProvider(connection.provider).revoke(tokens);
        revoked = true;
      }
    } catch {
      // The tokens are deleted below either way; an unrevoked token expires at the provider.
    }
  }
  const { data: ended, error } = await db.rpc("accounting_disconnect", { p_garage_id: input.garageId, p_actor: input.userId });
  if (error) throw new AccountingError("UNEXPECTED_RESPONSE", { detail: `disconnect (${error.code ?? "unknown"})` });
  return { revoked, ended: ended === true };
}
