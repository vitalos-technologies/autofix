import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { garageHasFeature } from "@/lib/plans/server";
import { isPlan } from "@/lib/plans/features";
import { openText, sealText, tokenAad } from "./crypto";
import type { AccountingSyncRepo, ConnectionRecord, InvoiceRecord, ItemPatch, PaymentRecord, SyncEntity, SyncItem } from "./sync";
import { AccountingError, isAccountingProviderId, type AccountingSettings, type TokenSet } from "./types";

// The service-role side of accounting sync (P5.10): the sync job's repository and the token store.
// Every query names the garage as well as the row id. Tokens are encrypted before they leave this
// module and decrypted only here; nothing else reads accounting_connection_secrets.

type Env = Readonly<Record<string, string | undefined>>;

function dbError(step: string, error: { code?: string | null } | null): never {
  const code = error?.code && /^[A-Za-z0-9_.-]{1,40}$/.test(error.code) ? error.code : "unknown";
  throw new AccountingError("UNEXPECTED_RESPONSE", { detail: `database ${step} (${code})` });
}

type ItemRow = { id: string; entity: SyncEntity; local_id: string; remote_id: string | null; status: SyncItem["status"]; attempts: number };

function toItem(row: ItemRow): SyncItem {
  return { id: row.id, entity: row.entity, localId: row.local_id, remoteId: row.remote_id, status: row.status, attempts: row.attempts };
}

function settingsOf(value: unknown): AccountingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AccountingSettings = {};
  for (const key of ["salesAccountCode", "bankAccountCode", "itemId", "taxCodeId", "ledgerAccountId", "bankAccountId"] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string" && field.length > 0 && field.length <= 100) out[key] = field;
  }
  return out;
}

type SealedTokens = { access_token_ct: string; refresh_token_ct: string | null; expires_at: string; refresh_expires_at: string | null };

/** Encrypts a token set for accounting_connection_secrets (the access token row also carries scopes and the tenant hint). */
export function sealTokens(garageId: string, tokens: TokenSet, env?: Env): SealedTokens {
  const aad = tokenAad(garageId);
  return {
    access_token_ct: sealText(JSON.stringify({ t: tokens.accessToken, s: tokens.scopes, h: tokens.tenantHint ?? null }), aad, env),
    refresh_token_ct: tokens.refreshToken ? sealText(tokens.refreshToken, aad, env) : null,
    expires_at: tokens.expiresAt.toISOString(),
    refresh_expires_at: tokens.refreshExpiresAt ? tokens.refreshExpiresAt.toISOString() : null,
  };
}

/** Decrypts a stored token set; null when the key changed or the row was tampered with. */
export function openTokens(garageId: string, row: SealedTokens, env?: Env): TokenSet | null {
  const aad = tokenAad(garageId);
  const access = openText(row.access_token_ct, aad, env);
  if (!access) return null;
  let parsed: { t?: unknown; s?: unknown; h?: unknown };
  try {
    parsed = JSON.parse(access) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.t !== "string") return null;
  const refresh = row.refresh_token_ct ? openText(row.refresh_token_ct, aad, env) : null;
  if (row.refresh_token_ct && !refresh) return null;
  return {
    accessToken: parsed.t,
    refreshToken: refresh,
    expiresAt: new Date(row.expires_at),
    refreshExpiresAt: row.refresh_expires_at ? new Date(row.refresh_expires_at) : null,
    scopes: Array.isArray(parsed.s) ? parsed.s.filter((scope): scope is string => typeof scope === "string") : [],
    tenantHint: typeof parsed.h === "string" ? parsed.h : null,
  };
}

export async function loadConnectionTokens(db: SupabaseClient, garageId: string, connectionId: string, env?: Env): Promise<TokenSet | null> {
  const { data, error } = await db
    .from("accounting_connection_secrets")
    .select("access_token_ct,refresh_token_ct,expires_at,refresh_expires_at")
    .eq("garage_id", garageId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) dbError("secrets.load", error);
  return data ? openTokens(garageId, data as SealedTokens, env) : null;
}

export async function saveConnectionTokens(db: SupabaseClient, garageId: string, connectionId: string, tokens: TokenSet, env?: Env) {
  const { error } = await db
    .from("accounting_connection_secrets")
    .update(sealTokens(garageId, tokens, env))
    .eq("garage_id", garageId)
    .eq("connection_id", connectionId);
  if (error) dbError("secrets.save", error);
}

export function mapConnectionRow(row: Record<string, unknown>): ConnectionRecord | null {
  if (!isAccountingProviderId(row.provider)) return null;
  return {
    id: String(row.id),
    garageId: String(row.garage_id),
    provider: row.provider,
    status: row.status as ConnectionRecord["status"],
    tenantId: typeof row.tenant_id === "string" ? row.tenant_id : null,
    settings: settingsOf(row.settings),
  };
}

export function createSupabaseAccountingRepo(db: SupabaseClient, env?: Env): AccountingSyncRepo {
  return {
    async garage(garageId) {
      const { data, error } = await db.from("garages").select("id,plan,trial_ends_at,plan_chosen,timezone,status").eq("id", garageId).maybeSingle();
      if (error) dbError("garage", error);
      if (!data || data.status === "cancelled") return null;
      const plan = isPlan(data.plan) ? data.plan : "essentials";
      const chosen = isPlan(data.plan_chosen) ? data.plan_chosen : null;
      return {
        hasFeature: garageHasFeature({ plan, trialEndsAt: data.trial_ends_at ?? null, planChosen: chosen }, "accounting_sync"),
        timeZone: typeof data.timezone === "string" ? data.timezone : "Europe/London",
      };
    },
    async connection(garageId) {
      const { data, error } = await db
        .from("accounting_connections")
        .select("id,garage_id,provider,status,tenant_id,settings")
        .eq("garage_id", garageId)
        .neq("status", "disconnected")
        .maybeSingle();
      if (error) dbError("connection", error);
      return data ? mapConnectionRow(data) : null;
    },
    loadTokens(garageId, connectionId) {
      return loadConnectionTokens(db, garageId, connectionId, env);
    },
    saveTokens(garageId, connectionId, tokens) {
      return saveConnectionTokens(db, garageId, connectionId, tokens, env);
    },
    async updateConnection(garageId, connectionId, patch) {
      const values: Record<string, unknown> = {};
      if (patch.status) values.status = patch.status;
      if (patch.lastErrorCode !== undefined) values.last_error_code = patch.lastErrorCode;
      if (patch.lastSyncAt) values.last_sync_at = patch.lastSyncAt.toISOString();
      if (!Object.keys(values).length) return;
      const { error } = await db.from("accounting_connections").update(values).eq("garage_id", garageId).eq("id", connectionId).neq("status", "disconnected");
      if (error) dbError("connection.update", error);
    },
    async dueItems(garageId, connectionId, now, limit) {
      const { data, error } = await db
        .from("accounting_sync_items")
        .select("id,entity,local_id,remote_id,status,attempts")
        .eq("garage_id", garageId)
        .eq("connection_id", connectionId)
        .eq("status", "pending")
        .lte("next_attempt_at", now.toISOString())
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) dbError("items.due", error);
      return ((data ?? []) as ItemRow[]).map(toItem);
    },
    async item(garageId, connectionId, entity, localId) {
      const { data, error } = await db
        .from("accounting_sync_items")
        .select("id,entity,local_id,remote_id,status,attempts")
        .eq("garage_id", garageId)
        .eq("connection_id", connectionId)
        .eq("entity", entity)
        .eq("local_id", localId)
        .maybeSingle();
      if (error) dbError("items.get", error);
      return data ? toItem(data as ItemRow) : null;
    },
    async ensureItem(garageId, connectionId, entity, localId) {
      const inserted = await db
        .from("accounting_sync_items")
        .upsert({ garage_id: garageId, connection_id: connectionId, entity, local_id: localId }, { onConflict: "connection_id,entity,local_id", ignoreDuplicates: true });
      if (inserted.error) dbError("items.ensure", inserted.error);
      const item = await this.item(garageId, connectionId, entity, localId);
      if (!item) throw new AccountingError("UNEXPECTED_RESPONSE", { detail: "item missing after insert" });
      return item;
    },
    async updateItem(garageId, itemId, patch: ItemPatch) {
      const values: Record<string, unknown> = {};
      if (patch.status) values.status = patch.status;
      if (patch.remoteId !== undefined) values.remote_id = patch.remoteId;
      if (patch.attempts !== undefined) values.attempts = Math.min(patch.attempts, 100);
      if (patch.nextAttemptAt) values.next_attempt_at = patch.nextAttemptAt.toISOString();
      if (patch.lastErrorCode !== undefined) values.last_error_code = patch.lastErrorCode;
      if (patch.syncedAt !== undefined) values.synced_at = patch.syncedAt ? patch.syncedAt.toISOString() : null;
      const { error } = await db.from("accounting_sync_items").update(values).eq("garage_id", garageId).eq("id", itemId);
      if (error) dbError("items.update", error);
    },
    async invoice(garageId, invoiceId): Promise<InvoiceRecord | null> {
      const { data, error } = await db
        .from("invoices")
        .select("id,status,invoice_number,issue_date,due_date,customer_id,customer_name,customer_email,customer_phone,subtotal_pence,discount_pence,tax_pence,total_pence,booking:bookings(reference),invoice_items(description,quantity,unit_price_pence,line_total_pence,position)")
        .eq("garage_id", garageId)
        .eq("id", invoiceId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) dbError("invoice", error);
      if (!data) return null;
      const booking = Array.isArray(data.booking) ? data.booking[0] : data.booking;
      const items = ((data.invoice_items ?? []) as { description: string; quantity: string | number; unit_price_pence: number | string; line_total_pence: number | string; position: number }[])
        .slice()
        .sort((a, b) => a.position - b.position);
      return {
        id: data.id,
        status: data.status,
        number: data.invoice_number,
        issueDate: data.issue_date,
        dueDate: data.due_date,
        customerId: data.customer_id,
        customerName: data.customer_name,
        customerEmail: data.customer_email,
        customerPhone: data.customer_phone,
        bookingReference: (booking as { reference?: string } | null)?.reference ?? null,
        subtotalPence: Number(data.subtotal_pence),
        discountPence: Number(data.discount_pence),
        taxPence: Number(data.tax_pence),
        totalPence: Number(data.total_pence),
        lines: items.map((item) => ({ description: item.description, quantity: String(item.quantity), unitPricePence: Number(item.unit_price_pence), lineTotalPence: Number(item.line_total_pence) })),
      };
    },
    async payment(garageId, paymentId): Promise<PaymentRecord | null> {
      const { data, error } = await db
        .from("invoice_payments")
        .select("id,invoice_id,amount_pence,paid_at,payment_method,payment_reference")
        .eq("garage_id", garageId)
        .eq("id", paymentId)
        .maybeSingle();
      if (error) dbError("payment", error);
      if (!data) return null;
      return { id: data.id, invoiceId: data.invoice_id, amountPence: Number(data.amount_pence), paidAt: data.paid_at, method: data.payment_method, reference: data.payment_reference };
    },
    async nextDueAt(garageId, connectionId) {
      const { data, error } = await db
        .from("accounting_sync_items")
        .select("next_attempt_at")
        .eq("garage_id", garageId)
        .eq("connection_id", connectionId)
        .eq("status", "pending")
        .order("next_attempt_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) dbError("items.next", error);
      return data ? new Date(data.next_attempt_at) : null;
    },
  };
}
