import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountingKey, openText, sealText, tokenAad } from "@/lib/accounting/crypto";
import { checkCallback, createOAuthState, openOAuthState, pkceChallenge, sealOAuthState } from "@/lib/accounting/oauth";
import { createFakeProvider, fakeAccountingStore, resetFakeAccountingStore } from "@/lib/accounting/providers/fake";
import { openTokens, sealTokens } from "@/lib/accounting/repository";
import { MAX_ATTEMPTS, runAccountingSync, type AccountingSyncRepo, type ConnectionRecord, type InvoiceRecord, type ItemPatch, type PaymentRecord, type SyncEntity, type SyncItem } from "@/lib/accounting/sync";
import { AccountingError, parseRetryAfter, penceToDecimal, type AccountingProvider, type TokenSet } from "@/lib/accounting/types";

// P5.10 unit tests: the sync engine against an in-memory repository and the fake provider, token
// encryption, and the OAuth state checks.

const GARAGE = "a1360000-0000-4000-8000-000000000001";
const T0 = new Date("2096-05-01T09:00:00Z");

type StoredItem = SyncItem & { nextAttemptAt: Date; lastErrorCode: string | null; createdAt: number };

class MemoryRepo implements AccountingSyncRepo {
  hasFeature = true;
  connectionRecord: ConnectionRecord | null = { id: "conn-1", garageId: GARAGE, provider: "xero", status: "connected", tenantId: "fake-org-1", settings: {} };
  tokens: TokenSet | null;
  connectionPatches: Record<string, unknown>[] = [];
  items: StoredItem[] = [];
  invoices = new Map<string, InvoiceRecord>();
  payments = new Map<string, PaymentRecord>();
  savedTokens = 0;
  private seq = 0;

  constructor(tokens: TokenSet) {
    this.tokens = tokens;
  }

  queue(entity: SyncEntity, localId: string) {
    this.seq += 1;
    const item: StoredItem = { id: `item-${this.seq}`, entity, localId, remoteId: null, status: "pending", attempts: 0, nextAttemptAt: new Date(0), lastErrorCode: null, createdAt: this.seq };
    this.items.push(item);
    return item;
  }

  get = (entity: SyncEntity, localId: string) => this.items.find((item) => item.entity === entity && item.localId === localId);

  async garage() {
    return { hasFeature: this.hasFeature, timeZone: "Europe/London" };
  }
  async connection() {
    return this.connectionRecord;
  }
  async loadTokens() {
    return this.tokens;
  }
  async saveTokens(_garage: string, _connection: string, tokens: TokenSet) {
    this.tokens = tokens;
    this.savedTokens += 1;
  }
  async updateConnection(_garage: string, _connection: string, patch: Record<string, unknown>) {
    this.connectionPatches.push(patch);
    if (patch.status && this.connectionRecord) this.connectionRecord = { ...this.connectionRecord, status: patch.status as ConnectionRecord["status"] };
  }
  async dueItems(_garage: string, _connection: string, now: Date, limit: number) {
    return this.items.filter((item) => item.status === "pending" && item.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit).map((item) => ({ ...item }));
  }
  async item(_garage: string, _connection: string, entity: SyncEntity, localId: string) {
    const found = this.get(entity, localId);
    return found ? { ...found } : null;
  }
  async ensureItem(_garage: string, _connection: string, entity: SyncEntity, localId: string) {
    return { ...(this.get(entity, localId) ?? this.queue(entity, localId)) };
  }
  async updateItem(_garage: string, itemId: string, patch: ItemPatch) {
    const item = this.items.find((candidate) => candidate.id === itemId)!;
    if (patch.status) item.status = patch.status;
    if (patch.remoteId !== undefined) item.remoteId = patch.remoteId;
    if (patch.attempts !== undefined) item.attempts = patch.attempts;
    if (patch.nextAttemptAt) item.nextAttemptAt = patch.nextAttemptAt;
    if (patch.lastErrorCode !== undefined) item.lastErrorCode = patch.lastErrorCode;
  }
  async invoice(_garage: string, id: string) {
    return this.invoices.get(id) ?? null;
  }
  async payment(_garage: string, id: string) {
    return this.payments.get(id) ?? null;
  }
  async nextDueAt() {
    const pending = this.items.filter((item) => item.status === "pending").map((item) => item.nextAttemptAt.getTime());
    return pending.length ? new Date(Math.min(...pending)) : null;
  }
}

function invoice(id: string, customerName = "Jo Bloggs", customerId: string | null = "cust-1"): InvoiceRecord {
  return {
    id,
    status: "issued",
    number: `ACP-2096-${id.slice(-6)}`,
    issueDate: "2096-05-01",
    dueDate: "2096-05-08",
    customerId,
    customerName,
    customerEmail: "jo@example.test",
    customerPhone: null,
    bookingReference: "ACP-1234",
    subtotalPence: 18000,
    discountPence: 1000,
    taxPence: 0,
    totalPence: 17000,
    lines: [
      { description: "Brake pads", quantity: "1.000", unitPricePence: 12000, lineTotalPence: 12000 },
      { description: "Labour", quantity: "1.500", unitPricePence: 4000, lineTotalPence: 6000 },
    ],
  };
}

async function freshTokens(provider: AccountingProvider) {
  const { createHash } = await import("node:crypto");
  return provider.exchangeCode({ code: `fake.${createHash("sha256").update("v").digest("base64url")}`, codeVerifier: "v", redirectUri: "https://x/cb", callbackParams: new URLSearchParams() });
}

describe("runAccountingSync", () => {
  let now: Date;
  let provider: AccountingProvider;
  let repo: MemoryRepo;
  let enqueued: Date[];

  const deps = () => ({ repo, provider: () => provider, now: () => now, enqueue: async (_garage: string, at: Date) => void enqueued.push(at) });

  beforeEach(async () => {
    resetFakeAccountingStore();
    now = T0;
    provider = createFakeProvider({ now: () => now });
    repo = new MemoryRepo(await freshTokens(provider));
    enqueued = [];
  });

  it("skips garages without the plan or a connection", async () => {
    repo.hasFeature = false;
    expect(await runAccountingSync(GARAGE, deps())).toEqual({ status: "skipped", reason: "plan" });
    repo.hasFeature = true;
    repo.connectionRecord = { ...repo.connectionRecord!, status: "needs_reconnect" };
    expect(await runAccountingSync(GARAGE, deps())).toEqual({ status: "skipped", reason: "not_connected" });
  });

  it("syncs the contact, then the invoice, then its payment, whatever order they were queued in", async () => {
    repo.invoices.set("inv-000001", invoice("inv-000001"));
    repo.payments.set("pay-1", { id: "pay-1", invoiceId: "inv-000001", amountPence: 5000, paidAt: "2096-05-01T23:30:00Z", method: "card", reference: null });
    repo.queue("payment", "pay-1");
    repo.queue("invoice", "inv-000001");
    const result = await runAccountingSync(GARAGE, deps());
    expect(result).toMatchObject({ status: "done", synced: 2, failed: 0 });
    expect(repo.get("invoice", "inv-000001")?.status).toBe("synced");
    expect(repo.get("payment", "pay-1")?.status).toBe("synced");
    expect(repo.get("contact", "cust-1")?.status).toBe("synced");
    const store = fakeAccountingStore();
    expect(store.invoices.size).toBe(1);
    const [payment] = [...store.payments.values()];
    // 23:30 UTC on 1 May is 00:30 on 2 May in London (BST): the payment date is the garage's local date.
    expect(payment.input.paidOn).toBe("2096-05-02");
    expect(payment.input.reference).toBe("ACP-2096-000001");
    expect(repo.connectionPatches.at(-1)).toMatchObject({ lastErrorCode: null, lastSyncAt: now });
    expect(enqueued).toEqual([]);
  });

  it("is idempotent: a second run with the items re-queued creates nothing new", async () => {
    repo.invoices.set("inv-000001", invoice("inv-000001"));
    repo.queue("invoice", "inv-000001");
    await runAccountingSync(GARAGE, deps());
    const item = repo.get("invoice", "inv-000001")!;
    item.status = "pending";
    await runAccountingSync(GARAGE, deps());
    expect(fakeAccountingStore().invoices.size).toBe(1);
    expect(fakeAccountingStore().contacts.size).toBe(1);
  });

  it("fails an item on a validation error at once, and a Retry then syncs it", async () => {
    repo.invoices.set("inv-000002", invoice("inv-000002", "Fail Once Motors", "cust-2"));
    repo.queue("invoice", "inv-000002");
    expect(await runAccountingSync(GARAGE, deps())).toMatchObject({ failed: 1 });
    const item = repo.get("invoice", "inv-000002")!;
    expect(item).toMatchObject({ status: "failed", lastErrorCode: "VALIDATION", attempts: 1 });
    expect(repo.connectionPatches.at(-1)).toMatchObject({ lastErrorCode: "VALIDATION" });
    Object.assign(item, { status: "pending", attempts: 0, lastErrorCode: null });
    expect(await runAccountingSync(GARAGE, deps())).toMatchObject({ synced: 1 });
    expect(item.status).toBe("synced");
  });

  it("stops on a rate limit and queues the next run after Retry-After (at least the next minute)", async () => {
    repo.invoices.set("inv-000003", invoice("inv-000003", "Rate Limit Garage", "cust-3"));
    repo.invoices.set("inv-000004", invoice("inv-000004"));
    repo.queue("invoice", "inv-000003");
    repo.queue("invoice", "inv-000004");
    const result = await runAccountingSync(GARAGE, deps());
    expect(result).toMatchObject({ status: "rate_limited", synced: 0 });
    expect(repo.get("invoice", "inv-000003")).toMatchObject({ status: "pending", attempts: 0, lastErrorCode: "RATE_LIMITED" });
    expect(repo.get("invoice", "inv-000004")?.status).toBe("pending");
    expect(enqueued).toEqual([new Date(T0.getTime() + 60_000)]);
    now = new Date(T0.getTime() + 60_000);
    expect(await runAccountingSync(GARAGE, deps())).toMatchObject({ status: "done", synced: 2 });
  });

  it("marks the connection needs_reconnect when the provider keeps refusing the tokens, keeping items pending", async () => {
    repo.invoices.set("inv-000005", invoice("inv-000005", "Auth Expired Ltd", "cust-5"));
    repo.queue("invoice", "inv-000005");
    const result = await runAccountingSync(GARAGE, deps());
    expect(result.status).toBe("needs_reconnect");
    expect(repo.connectionRecord?.status).toBe("needs_reconnect");
    expect(repo.connectionPatches.at(-1)).toMatchObject({ status: "needs_reconnect", lastErrorCode: "AUTH_EXPIRED" });
    expect(repo.get("invoice", "inv-000005")?.status).toBe("pending");
    // It refreshed once before giving up.
    expect(repo.savedTokens).toBe(1);
  });

  it("refreshes a token about to expire before calling the provider, and needs a reconnect when the refresh is refused", async () => {
    repo.invoices.set("inv-000006", invoice("inv-000006"));
    repo.queue("invoice", "inv-000006");
    repo.tokens = { ...repo.tokens!, expiresAt: new Date(T0.getTime() + 30_000) };
    await runAccountingSync(GARAGE, deps());
    expect(repo.savedTokens).toBe(1);
    expect(repo.get("invoice", "inv-000006")?.status).toBe("synced");

    repo.invoices.set("inv-000007", invoice("inv-000007"));
    repo.queue("invoice", "inv-000007");
    repo.tokens = { ...repo.tokens!, expiresAt: new Date(T0.getTime() - 1), refreshToken: "fake-refresh-expired" };
    expect((await runAccountingSync(GARAGE, deps())).status).toBe("needs_reconnect");
  });

  it("backs off retryable errors (2, 4, 8 … minutes) and fails after the last attempt", async () => {
    const flaky: AccountingProvider = { ...provider, pushInvoice: vi.fn(async () => { throw new AccountingError("PROVIDER_UNAVAILABLE", { status: 503 }); }) };
    repo.invoices.set("inv-000008", invoice("inv-000008"));
    repo.queue("invoice", "inv-000008");
    const run = () => runAccountingSync(GARAGE, { ...deps(), provider: () => flaky });
    await run();
    const item = repo.get("invoice", "inv-000008")!;
    expect(item).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "PROVIDER_UNAVAILABLE" });
    expect(item.nextAttemptAt).toEqual(new Date(T0.getTime() + 2 * 60_000));
    expect(enqueued.at(-1)).toEqual(new Date(T0.getTime() + 2 * 60_000));
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      now = item.nextAttemptAt;
      await run();
    }
    expect(item).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("fails a payment whose invoice failed, and leaves one whose invoice is still pending for later", async () => {
    repo.payments.set("pay-2", { id: "pay-2", invoiceId: "inv-x", amountPence: 100, paidAt: T0.toISOString(), method: "cash", reference: null });
    const invoiceItem = repo.queue("invoice", "inv-x");
    invoiceItem.nextAttemptAt = new Date(T0.getTime() + 3_600_000);
    repo.queue("payment", "pay-2");
    expect(await runAccountingSync(GARAGE, deps())).toMatchObject({ deferred: 1 });
    expect(repo.get("payment", "pay-2")?.status).toBe("pending");
    invoiceItem.status = "failed";
    now = new Date(T0.getTime() + 120_000);
    await runAccountingSync(GARAGE, deps());
    expect(repo.get("payment", "pay-2")).toMatchObject({ status: "failed", lastErrorCode: "INVOICE_NOT_SYNCED" });
  });

  it("does not send void invoices", async () => {
    repo.invoices.set("inv-000009", { ...invoice("inv-000009"), status: "void" });
    repo.queue("invoice", "inv-000009");
    await runAccountingSync(GARAGE, deps());
    expect(repo.get("invoice", "inv-000009")).toMatchObject({ status: "failed", lastErrorCode: "INVOICE_VOID" });
    expect(fakeAccountingStore().invoices.size).toBe(0);
  });

  it("stops at the deadline and queues a continuation", async () => {
    repo.invoices.set("inv-000010", invoice("inv-000010"));
    repo.queue("invoice", "inv-000010");
    const result = await runAccountingSync(GARAGE, { ...deps(), deadline: 0, clock: () => 1 });
    expect(result).toMatchObject({ synced: 0 });
    expect(enqueued).toEqual([new Date(T0.getTime() + 60_000)]);
  });
});

describe("token encryption", () => {
  const KEY = { ACCOUNTING_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"), NODE_ENV: "production" };

  it("round-trips and binds ciphertext to its garage", () => {
    const sealed = sealText("secret-token", tokenAad(GARAGE), KEY);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("secret-token");
    expect(openText(sealed, tokenAad(GARAGE), KEY)).toBe("secret-token");
    expect(openText(sealed, tokenAad("b1360000-0000-4000-8000-000000000001"), KEY)).toBeNull();
    expect(openText(sealed, tokenAad(GARAGE), { ACCOUNTING_TOKEN_KEY: Buffer.alloc(32, 8).toString("hex") })).toBeNull();
    expect(openText("v1.bad", tokenAad(GARAGE), KEY)).toBeNull();
  });

  it("refuses to run in production without a key, and rejects keys of the wrong size", () => {
    expect(() => accountingKey({ NODE_ENV: "production" })).toThrow(/CONFIGURATION_REQUIRED/);
    expect(() => accountingKey({ ACCOUNTING_TOKEN_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(accountingKey({ NODE_ENV: "test" })).toHaveLength(32);
  });

  it("seals a whole token set for the secrets table and opens it again", () => {
    const tokens: TokenSet = { accessToken: "a-token", refreshToken: "r-token", expiresAt: T0, refreshExpiresAt: null, scopes: ["x"], tenantHint: "123" };
    const row = sealTokens(GARAGE, tokens, KEY);
    expect(JSON.stringify(row)).not.toMatch(/a-token|r-token/);
    expect(openTokens(GARAGE, row, KEY)).toEqual(tokens);
    expect(openTokens("other", row, KEY)).toBeNull();
  });
});

describe("OAuth state", () => {
  const env = { ACCOUNTING_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64") };

  it("seals the state cookie and checks the callback against the session", () => {
    const state = createOAuthState({ provider: "xero", garageId: GARAGE, userId: "user-1", now: T0 });
    const opened = openOAuthState(sealOAuthState(state, env), env);
    expect(opened).toEqual(state);
    expect(openOAuthState("tampered", env)).toBeNull();
    const ok = { state: state.state, provider: "xero" as const, garageId: GARAGE, userId: "user-1", now: T0 };
    expect(checkCallback(opened, ok)).toBeNull();
    expect(checkCallback(null, ok)).toBe("missing_state");
    expect(checkCallback(opened, { ...ok, state: "x".repeat(state.state.length) })).toBe("state_mismatch");
    expect(checkCallback(opened, { ...ok, now: new Date(T0.getTime() + 11 * 60_000) })).toBe("expired");
    expect(checkCallback(opened, { ...ok, provider: "sage" })).toBe("wrong_provider");
    expect(checkCallback(opened, { ...ok, garageId: "other" })).toBe("wrong_garage");
    expect(checkCallback(opened, { ...ok, userId: "user-2" })).toBe("wrong_user");
  });

  it("uses S256 PKCE", () => {
    // RFC 7636 appendix B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("helpers", () => {
  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(new Date(T0.getTime() + 30_000).toUTCString(), T0)).toBe(30);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("formats pence as decimals", () => {
    expect(penceToDecimal(17000)).toBe("170.00");
    expect(penceToDecimal(5)).toBe("0.05");
    expect(penceToDecimal(-1000)).toBe("-10.00");
  });
});
