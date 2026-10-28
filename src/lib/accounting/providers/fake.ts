// The fake accounting provider (P5.10): the default (ACCOUNTING_PROVIDER_MODE=fake) for development,
// tests and e2e. It behaves like the real ones at the contract level: OAuth with PKCE (the
// "consent" sends the browser straight back to our callback with a code that carries the
// challenge), two organisations to choose from, idempotent creates, payments only against known
// invoices and never above the balance. State is in memory for the process.
//
// Deterministic failure switches for tests and the e2e journey, by customer name:
//   "Fail Once"     the first invoice push for that contact fails with VALIDATION
//   "Rate Limit"    the first invoice push answers RATE_LIMITED (Retry-After 1 s)
//   "Auth Expired"  every push answers AUTH_EXPIRED and refresh fails (the connection needs reconnecting)

import { createHash, randomBytes } from "node:crypto";
import {
  AccountingError,
  type AccountingProvider,
  type AccountingTenant,
  type InvoiceInput,
  type PaymentInput,
  type ProviderContext,
  type TokenSet,
} from "../types";

export const FAKE_TENANTS: AccountingTenant[] = [
  { id: "fake-org-1", name: "Demo Garage Ltd (test)" },
  { id: "fake-org-2", name: "Second Company Ltd (test)" },
];
export const FAKE_SCOPES = ["accounting.fake"] as const;

type FakeContact = { id: string; name: string; email: string | null; phone: string | null; localId: string };
type FakeInvoice = { id: string; contactId: string; number: string; totalPence: number; paidPence: number; input: InvoiceInput };
type FakePayment = { id: string; invoiceId: string; amountPence: number; input: PaymentInput };

type FakeStore = {
  contacts: Map<string, FakeContact>;
  invoices: Map<string, FakeInvoice>;
  payments: Map<string, FakePayment>;
  /** idempotency key → remote id */
  idempotency: Map<string, string>;
  revoked: Set<string>;
  /** failure switches already used (key = contact id + kind) */
  tripped: Set<string>;
  sequence: number;
  calls: { op: string; tenantId?: string }[];
};

const STORE_KEY = Symbol.for("autofix.accounting.fakeStore");

export function fakeAccountingStore(): FakeStore {
  const globalRecord = globalThis as unknown as Record<symbol, FakeStore | undefined>;
  globalRecord[STORE_KEY] ??= {
    contacts: new Map(),
    invoices: new Map(),
    payments: new Map(),
    idempotency: new Map(),
    revoked: new Set(),
    tripped: new Set(),
    sequence: 0,
    calls: [],
  };
  return globalRecord[STORE_KEY]!;
}

export function resetFakeAccountingStore() {
  const globalRecord = globalThis as unknown as Record<symbol, FakeStore | undefined>;
  globalRecord[STORE_KEY] = undefined;
}

function nextId(store: FakeStore, prefix: string) {
  store.sequence += 1;
  return `${prefix}-${String(store.sequence).padStart(6, "0")}`;
}

function challengeOf(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export type FakeProviderOptions = { now?: () => Date; tokenLifetimeSeconds?: number };

export function createFakeProvider(options: FakeProviderOptions = {}): AccountingProvider {
  const now = options.now ?? (() => new Date());
  const lifetime = options.tokenLifetimeSeconds ?? 1800;

  function issue(): TokenSet {
    const at = now();
    return {
      accessToken: `fake-access-${randomBytes(12).toString("base64url")}`,
      refreshToken: `fake-refresh-${randomBytes(12).toString("base64url")}`,
      expiresAt: new Date(at.getTime() + lifetime * 1000),
      refreshExpiresAt: new Date(at.getTime() + 60 * 24 * 3600 * 1000),
      scopes: [...FAKE_SCOPES],
      tenantHint: null,
    };
  }

  function authorise(context: ProviderContext, op: string) {
    const store = fakeAccountingStore();
    store.calls.push({ op, tenantId: context.tenantId });
    if (!context.tokens.accessToken.startsWith("fake-access-") || store.revoked.has(context.tokens.accessToken)) {
      throw new AccountingError("AUTH_EXPIRED", { status: 401, detail: "fake token refused" });
    }
    if (context.tokens.expiresAt.getTime() <= now().getTime()) throw new AccountingError("AUTH_EXPIRED", { status: 401, detail: "fake token expired" });
    if (!FAKE_TENANTS.some((tenant) => tenant.id === context.tenantId)) throw new AccountingError("NOT_FOUND", { status: 404, detail: "unknown organisation" });
    return store;
  }

  function idempotent(store: FakeStore, context: ProviderContext, create: () => string): { remoteId: string } {
    const key = `${context.tenantId}:${context.idempotencyKey}`;
    const existing = store.idempotency.get(key);
    if (existing) return { remoteId: existing };
    const id = create();
    store.idempotency.set(key, id);
    return { remoteId: id };
  }

  function trip(store: FakeStore, key: string) {
    if (store.tripped.has(key)) return false;
    store.tripped.add(key);
    return true;
  }

  return {
    id: "fake",
    name: "Test accounts (fake)",
    configured: true,
    scopes: FAKE_SCOPES,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(redirectUri);
      url.searchParams.set("code", `fake.${codeChallenge}`);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier }) {
      fakeAccountingStore().calls.push({ op: "exchange" });
      if (!code.startsWith("fake.") || code.slice(5) !== challengeOf(codeVerifier)) {
        throw new AccountingError("AUTH_EXPIRED", { status: 400, detail: "invalid_grant" });
      }
      return issue();
    },
    async refresh(tokens) {
      const store = fakeAccountingStore();
      store.calls.push({ op: "refresh" });
      if (!tokens.refreshToken || store.revoked.has(tokens.refreshToken) || tokens.refreshToken.includes("expired")) {
        throw new AccountingError("AUTH_EXPIRED", { status: 400, detail: "invalid_grant" });
      }
      store.revoked.add(tokens.refreshToken);
      return issue();
    },
    async revoke(tokens) {
      const store = fakeAccountingStore();
      store.calls.push({ op: "revoke" });
      if (tokens.refreshToken) store.revoked.add(tokens.refreshToken);
      store.revoked.add(tokens.accessToken);
    },
    async listTenants(tokens) {
      const store = fakeAccountingStore();
      if (store.revoked.has(tokens.accessToken)) throw new AccountingError("AUTH_EXPIRED", { status: 401 });
      return FAKE_TENANTS.map((tenant) => ({ ...tenant }));
    },
    async upsertContact(context, contact) {
      const store = authorise(context, "upsertContact");
      if (!contact.name.trim()) throw new AccountingError("VALIDATION", { status: 400, detail: "name required" });
      if (contact.remoteId && store.contacts.has(contact.remoteId)) {
        store.contacts.set(contact.remoteId, { ...store.contacts.get(contact.remoteId)!, name: contact.name, email: contact.email, phone: contact.phone });
        return { remoteId: contact.remoteId };
      }
      const byLocal = [...store.contacts.values()].find((row) => row.localId === contact.localId);
      if (byLocal) return { remoteId: byLocal.id };
      return idempotent(store, context, () => {
        const id = nextId(store, "fake-contact");
        store.contacts.set(id, { id, name: contact.name, email: contact.email, phone: contact.phone, localId: contact.localId });
        return id;
      });
    },
    async pushInvoice(context, invoice) {
      const store = authorise(context, "pushInvoice");
      const contact = store.contacts.get(invoice.contactRemoteId);
      if (!contact) throw new AccountingError("VALIDATION", { status: 400, detail: "unknown contact" });
      if (/auth expired/i.test(contact.name)) throw new AccountingError("AUTH_EXPIRED", { status: 401, detail: "fake switch" });
      if (/rate limit/i.test(contact.name) && trip(store, `${contact.id}:rate`)) throw new AccountingError("RATE_LIMITED", { status: 429, retryAfterSeconds: 1 });
      if (/fail once/i.test(contact.name) && trip(store, `${contact.id}:fail`)) throw new AccountingError("VALIDATION", { status: 400, detail: "fake switch" });
      const sum = invoice.lines.reduce((total, line) => total + line.lineTotalPence, 0) - invoice.discountPence + invoice.taxPence;
      if (sum !== invoice.totalPence || invoice.lines.length === 0) throw new AccountingError("VALIDATION", { status: 400, detail: "totals do not add up" });
      return idempotent(store, context, () => {
        const id = nextId(store, "fake-invoice");
        store.invoices.set(id, { id, contactId: contact.id, number: invoice.number, totalPence: invoice.totalPence, paidPence: 0, input: invoice });
        return id;
      });
    },
    async pushPayment(context, payment) {
      const store = authorise(context, "pushPayment");
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const repeated = store.idempotency.get(key);
      if (repeated) return { remoteId: repeated };
      const invoice = store.invoices.get(payment.invoiceRemoteId);
      if (!invoice) throw new AccountingError("NOT_FOUND", { status: 404, detail: "unknown invoice" });
      if (payment.amountPence <= 0 || invoice.paidPence + payment.amountPence > invoice.totalPence) {
        throw new AccountingError("VALIDATION", { status: 400, detail: "payment above balance" });
      }
      return idempotent(store, context, () => {
        const id = nextId(store, "fake-payment");
        invoice.paidPence += payment.amountPence;
        store.payments.set(id, { id, invoiceId: invoice.id, amountPence: payment.amountPence, input: payment });
        return id;
      });
    },
  };
}
