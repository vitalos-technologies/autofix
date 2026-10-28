// The accounting sync engine (P5.10): works through one garage's due sync items against its
// connected provider. Pure orchestration over two seams, an AccountingSyncRepo (the database) and
// the provider, so unit tests drive it with in-memory fakes.
//
// Rules:
//   - Only Pro garages (accounting_sync) with a `connected` connection; anything else is skipped.
//   - Order: invoices before payments; a contact is created/found on the way (idempotent per
//     connection + contact key). A payment waits until its invoice is synced.
//   - Tokens are refreshed a minute before they expire and once more on AUTH_EXPIRED; when the
//     refresh is refused the connection becomes needs_reconnect (the settings page shows a banner)
//     and the items stay pending for after the reconnect.
//   - RATE_LIMITED stops the run and queues the next one after Retry-After.
//   - Retryable errors back off 2, 4, 8 … minutes and fail after MAX_ATTEMPTS; validation and
//     not-found errors fail the item at once (the owner can Retry after fixing it).
//   - Only error codes are stored and logged, never provider text or customer data.

import { localDateKey } from "@/lib/admin/dates";
import { AccountingError, isAccountingError, type AccountingProvider, type AccountingProviderId, type AccountingSettings, type ContactInput, type InvoiceInput, type PaymentInput, type TokenSet } from "./types";

export const MAX_ATTEMPTS = 6;
export const BATCH_LIMIT = 25;
/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000;

export type SyncEntity = "contact" | "invoice" | "payment";
export type SyncItemStatus = "pending" | "synced" | "failed";

export type SyncItem = {
  id: string;
  entity: SyncEntity;
  localId: string;
  remoteId: string | null;
  status: SyncItemStatus;
  attempts: number;
};

export type ConnectionRecord = {
  id: string;
  garageId: string;
  provider: AccountingProviderId;
  status: "pending" | "connected" | "needs_reconnect" | "disconnected";
  tenantId: string | null;
  settings: AccountingSettings;
};

export type InvoiceRecord = {
  id: string;
  status: "draft" | "issued" | "paid" | "void";
  number: string | null;
  issueDate: string | null;
  dueDate: string | null;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  bookingReference: string | null;
  subtotalPence: number;
  discountPence: number;
  taxPence: number;
  totalPence: number;
  lines: { description: string; quantity: string; unitPricePence: number; lineTotalPence: number }[];
};

export type PaymentRecord = {
  id: string;
  invoiceId: string;
  amountPence: number;
  paidAt: string;
  method: "cash" | "card" | "bank_transfer" | "other";
  reference: string | null;
};

export type ItemPatch = Partial<{
  status: SyncItemStatus;
  remoteId: string | null;
  attempts: number;
  nextAttemptAt: Date;
  lastErrorCode: string | null;
  syncedAt: Date | null;
}>;

export interface AccountingSyncRepo {
  /** The garage's plan includes accounting_sync, and its time zone. Null when the garage is gone. */
  garage(garageId: string): Promise<{ hasFeature: boolean; timeZone: string } | null>;
  /** The active (not disconnected) connection. */
  connection(garageId: string): Promise<ConnectionRecord | null>;
  loadTokens(garageId: string, connectionId: string): Promise<TokenSet | null>;
  saveTokens(garageId: string, connectionId: string, tokens: TokenSet): Promise<void>;
  updateConnection(garageId: string, connectionId: string, patch: Partial<{ status: "needs_reconnect"; lastErrorCode: string | null; lastSyncAt: Date }>): Promise<void>;
  dueItems(garageId: string, connectionId: string, now: Date, limit: number): Promise<SyncItem[]>;
  item(garageId: string, connectionId: string, entity: SyncEntity, localId: string): Promise<SyncItem | null>;
  ensureItem(garageId: string, connectionId: string, entity: SyncEntity, localId: string): Promise<SyncItem>;
  updateItem(garageId: string, itemId: string, patch: ItemPatch): Promise<void>;
  invoice(garageId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  payment(garageId: string, paymentId: string): Promise<PaymentRecord | null>;
  /** Earliest next_attempt_at of the connection's pending items. */
  nextDueAt(garageId: string, connectionId: string): Promise<Date | null>;
}

export type SyncLogger = { info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void; warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void };

export type SyncDeps = {
  repo: AccountingSyncRepo;
  provider: (id: AccountingProviderId) => AccountingProvider;
  now: () => Date;
  /** Queue the next accounting.sync run for this garage (dedupe per minute in SQL). */
  enqueue: (garageId: string, runAt: Date) => Promise<void>;
  /** Stop starting new provider calls after this (epoch ms on `clock`). */
  deadline?: number;
  clock?: () => number;
  log?: SyncLogger;
};

export type SyncResult =
  | { status: "skipped"; reason: "no_garage" | "plan" | "not_connected" }
  | { status: "needs_reconnect" | "rate_limited" | "done"; synced: number; failed: number; deferred: number };

class StopRun extends Error {
  constructor(readonly kind: "needs_reconnect" | "rate_limited", readonly retryAfterSeconds = 0) {
    super(kind);
  }
}

export function backoffMinutes(attempts: number): number {
  return 2 ** Math.min(Math.max(attempts, 1), 10);
}

function contactKey(invoice: InvoiceRecord): string {
  return invoice.customerId ?? invoice.id;
}

/** The engine for one garage. */
export async function runAccountingSync(garageId: string, deps: SyncDeps): Promise<SyncResult> {
  const { repo } = deps;
  const clock = deps.clock ?? Date.now;
  const garage = await repo.garage(garageId);
  if (!garage) return { status: "skipped", reason: "no_garage" };
  if (!garage.hasFeature) return { status: "skipped", reason: "plan" };
  const connection = await repo.connection(garageId);
  if (!connection || connection.status !== "connected" || !connection.tenantId) return { status: "skipped", reason: "not_connected" };
  const tenantId = connection.tenantId;
  const provider = deps.provider(connection.provider);

  let tokens = await repo.loadTokens(garageId, connection.id);
  if (!tokens) {
    await repo.updateConnection(garageId, connection.id, { status: "needs_reconnect", lastErrorCode: "AUTH_EXPIRED" });
    return { status: "needs_reconnect", synced: 0, failed: 0, deferred: 0 };
  }
  let refreshedThisRun = false;

  async function refresh() {
    try {
      tokens = await provider.refresh(tokens!);
      refreshedThisRun = true;
      await repo.saveTokens(garageId, connection!.id, tokens);
    } catch (error) {
      if (isAccountingError(error) && (error.code === "AUTH_EXPIRED" || error.code === "VALIDATION")) throw new StopRun("needs_reconnect");
      throw error;
    }
  }

  /** One provider call with token refresh: before expiry, and once more on AUTH_EXPIRED. */
  async function call<T>(idempotencyKey: string, run: (context: Parameters<AccountingProvider["pushInvoice"]>[0]) => Promise<T>): Promise<T> {
    if (tokens!.expiresAt.getTime() - REFRESH_MARGIN_MS <= deps.now().getTime()) await refresh();
    try {
      return await run({ tokens: tokens!, tenantId, settings: connection!.settings, idempotencyKey });
    } catch (error) {
      if (!isAccountingError(error)) throw error;
      if (error.code === "RATE_LIMITED") throw new StopRun("rate_limited", error.retryAfterSeconds ?? 60);
      if (error.code !== "AUTH_EXPIRED") throw error;
      if (refreshedThisRun) throw new StopRun("needs_reconnect");
      await refresh();
      try {
        return await run({ tokens: tokens!, tenantId, settings: connection!.settings, idempotencyKey });
      } catch (retryError) {
        if (isAccountingError(retryError) && retryError.code === "AUTH_EXPIRED") throw new StopRun("needs_reconnect");
        if (isAccountingError(retryError) && retryError.code === "RATE_LIMITED") throw new StopRun("rate_limited", retryError.retryAfterSeconds ?? 60);
        throw retryError;
      }
    }
  }

  async function ensureContact(invoice: InvoiceRecord): Promise<string> {
    const key = contactKey(invoice);
    const item = await repo.ensureItem(garageId, connection!.id, "contact", key);
    if (item.status === "synced" && item.remoteId) return item.remoteId;
    const contact: ContactInput = { localId: key, name: invoice.customerName, email: invoice.customerEmail, phone: invoice.customerPhone, remoteId: item.remoteId };
    const { remoteId } = await call(`af-contact-${connection!.id}-${key}`, (context) => provider.upsertContact(context, contact));
    await repo.updateItem(garageId, item.id, { status: "synced", remoteId, syncedAt: deps.now(), lastErrorCode: null, attempts: item.attempts + 1 });
    return remoteId;
  }

  function invoiceInput(invoice: InvoiceRecord, contactRemoteId: string): InvoiceInput {
    return {
      localId: invoice.id,
      contactRemoteId,
      number: invoice.number!,
      reference: invoice.bookingReference ? `Booking ${invoice.bookingReference}` : null,
      issueDate: invoice.issueDate!,
      dueDate: invoice.dueDate ?? invoice.issueDate!,
      currency: "GBP",
      lines: invoice.lines.map((line) => ({ ...line, taxPence: 0 })),
      discountPence: invoice.discountPence,
      taxPence: invoice.taxPence,
      totalPence: invoice.totalPence,
    };
  }

  type Outcome = { kind: "synced"; remoteId: string } | { kind: "deferred"; until: Date } | { kind: "failed"; code: string };

  async function syncInvoice(item: SyncItem): Promise<Outcome> {
    const invoice = await repo.invoice(garageId, item.localId);
    if (!invoice) return { kind: "failed", code: "LOCAL_NOT_FOUND" };
    if (invoice.status === "draft" || !invoice.number || !invoice.issueDate) return { kind: "failed", code: "INVOICE_NOT_ISSUED" };
    if (invoice.status === "void") return { kind: "failed", code: "INVOICE_VOID" };
    const contactRemoteId = await ensureContact(invoice);
    const { remoteId } = await call(`af-invoice-${connection!.id}-${invoice.id}`, (context) => provider.pushInvoice(context, invoiceInput(invoice, contactRemoteId)));
    return { kind: "synced", remoteId };
  }

  async function syncPayment(item: SyncItem): Promise<Outcome> {
    const payment = await repo.payment(garageId, item.localId);
    if (!payment) return { kind: "failed", code: "LOCAL_NOT_FOUND" };
    let invoiceItem = await repo.item(garageId, connection!.id, "invoice", payment.invoiceId);
    if (!invoiceItem) invoiceItem = await repo.ensureItem(garageId, connection!.id, "invoice", payment.invoiceId);
    if (invoiceItem.status === "failed") return { kind: "failed", code: "INVOICE_NOT_SYNCED" };
    if (invoiceItem.status !== "synced" || !invoiceItem.remoteId) return { kind: "deferred", until: new Date(deps.now().getTime() + 60_000) };
    const invoice = await repo.invoice(garageId, payment.invoiceId);
    if (!invoice) return { kind: "failed", code: "LOCAL_NOT_FOUND" };
    const contactRemoteId = await ensureContact(invoice);
    const input: PaymentInput = {
      localId: payment.id,
      invoiceRemoteId: invoiceItem.remoteId,
      contactRemoteId,
      amountPence: payment.amountPence,
      paidOn: localDateKey(payment.paidAt, garage!.timeZone),
      reference: payment.reference ? payment.reference.slice(0, 60) : invoice.number,
      method: payment.method,
    };
    const { remoteId } = await call(`af-payment-${connection!.id}-${payment.id}`, (context) => provider.pushPayment(context, input));
    return { kind: "synced", remoteId };
  }

  let synced = 0;
  let failed = 0;
  let deferred = 0;
  let lastErrorCode: string | null = null;
  let stop: StopRun | null = null;

  const items = await repo.dueItems(garageId, connection.id, deps.now(), BATCH_LIMIT);
  const order: Record<SyncEntity, number> = { contact: 0, invoice: 1, payment: 2 };
  items.sort((a, b) => order[a.entity] - order[b.entity]);

  for (const item of items) {
    if (deps.deadline !== undefined && clock() >= deps.deadline) break;
    try {
      const outcome: Outcome = item.entity === "invoice"
        ? await syncInvoice(item)
        : item.entity === "payment"
          ? await syncPayment(item)
          : { kind: "deferred", until: new Date(deps.now().getTime() + 60_000) };
      if (outcome.kind === "synced") {
        synced += 1;
        await repo.updateItem(garageId, item.id, { status: "synced", remoteId: outcome.remoteId, syncedAt: deps.now(), lastErrorCode: null, attempts: item.attempts + 1 });
      } else if (outcome.kind === "deferred") {
        deferred += 1;
        await repo.updateItem(garageId, item.id, { nextAttemptAt: outcome.until });
      } else {
        failed += 1;
        lastErrorCode = outcome.code;
        await repo.updateItem(garageId, item.id, { status: "failed", lastErrorCode: outcome.code, attempts: item.attempts + 1 });
      }
    } catch (error) {
      if (error instanceof StopRun) {
        stop = error;
        if (error.kind === "rate_limited") {
          await repo.updateItem(garageId, item.id, { nextAttemptAt: new Date(deps.now().getTime() + error.retryAfterSeconds * 1000), lastErrorCode: "RATE_LIMITED" });
        }
        break;
      }
      const code = isAccountingError(error) ? error.code : "UNEXPECTED";
      lastErrorCode = code;
      const attempts = item.attempts + 1;
      const permanent = isAccountingError(error) ? !error.retryable : false;
      if (permanent || attempts >= MAX_ATTEMPTS) {
        failed += 1;
        await repo.updateItem(garageId, item.id, { status: "failed", lastErrorCode: code, attempts });
      } else {
        deferred += 1;
        await repo.updateItem(garageId, item.id, { attempts, lastErrorCode: code, nextAttemptAt: new Date(deps.now().getTime() + backoffMinutes(attempts) * 60_000) });
      }
      deps.log?.warn("accounting.item_failed", { entity: item.entity, code, attempts, permanent });
    }
  }

  if (stop?.kind === "needs_reconnect") {
    await repo.updateConnection(garageId, connection.id, { status: "needs_reconnect", lastErrorCode: "AUTH_EXPIRED", ...(synced ? { lastSyncAt: deps.now() } : {}) });
    deps.log?.warn("accounting.needs_reconnect", { provider: connection.provider });
    return { status: "needs_reconnect", synced, failed, deferred };
  }

  await repo.updateConnection(garageId, connection.id, {
    lastErrorCode: stop?.kind === "rate_limited" ? "RATE_LIMITED" : lastErrorCode,
    ...(synced ? { lastSyncAt: deps.now() } : {}),
  });

  // Queue the next run: after Retry-After, at the next item's backoff, or straight away (next minute)
  // when this run stopped at its batch size or deadline.
  const now = deps.now();
  const nextMinute = new Date(now.getTime() + 60_000);
  let next: Date | null = null;
  if (stop?.kind === "rate_limited") next = new Date(now.getTime() + Math.max(stop.retryAfterSeconds, 1) * 1000);
  else next = await repo.nextDueAt(garageId, connection.id);
  if (next) await deps.enqueue(garageId, next < nextMinute ? nextMinute : next);

  return { status: stop?.kind === "rate_limited" ? "rate_limited" : "done", synced, failed, deferred };
}

export { AccountingError };
