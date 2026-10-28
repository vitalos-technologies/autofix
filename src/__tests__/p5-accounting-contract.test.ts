import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import quickbooksFixture from "./fixtures/accounting/quickbooks.json";
import sageFixture from "./fixtures/accounting/sage.json";
import xeroFixture from "./fixtures/accounting/xero.json";
import type { FetchLike } from "@/lib/accounting/http";
import { createFakeProvider, resetFakeAccountingStore } from "@/lib/accounting/providers/fake";
import { createQuickBooksProvider, quickbooksRequests } from "@/lib/accounting/providers/quickbooks";
import { createSageProvider, sageRequests } from "@/lib/accounting/providers/sage";
import { createXeroProvider, xeroRequests } from "@/lib/accounting/providers/xero";
import { getAccountingProvider } from "@/lib/accounting/providers";
import { AccountingError, type AccountingProvider, type InvoiceInput, type PaymentInput, type ProviderContext, type TokenSet } from "@/lib/accounting/types";

// P5.10 contract tests: every adapter's request builders and response mappers against recorded
// fixtures (hand-written from each provider's documented examples, src/__tests__/fixtures/accounting),
// and the fake against the same behavioural contract.

const NOW = new Date("2096-05-01T09:00:00Z");
const REDIRECT = "https://autofix.vitalos.co.uk/api/admin/accounting/xero/callback";

type FixtureResponse = { status: number; body: unknown; headers?: Record<string, string> };
type Fixture = { responses: Record<string, FixtureResponse>; requests: Record<string, { method: string; url: string; headers: Record<string, string>; body: unknown }> };

function pick<T>(record: Record<string, T>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`fixture ${key} missing`);
  return value;
}

type Route = { method: string; test: (url: string) => boolean; response: string };
type Recorded = { method: string; url: string; headers: Record<string, string>; body: string | undefined };

function fixtureFetch(fixture: Fixture, routes: Route[], recorded: Recorded[]): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    recorded.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? init.body : undefined });
    const route = routes.find((candidate) => candidate.method === method && candidate.test(url));
    if (!route) return new Response(JSON.stringify({ message: "no fixture" }), { status: 599 });
    const response = pick(fixture.responses, route.response);
    return new Response(response.body === null ? null : JSON.stringify(response.body), { status: response.status, headers: response.headers });
  };
}

const INVOICE = (contactRemoteId: string): InvoiceInput => ({
  localId: "21360000-0000-4000-8000-000000000001",
  contactRemoteId,
  number: "ACP-2096-000001",
  reference: "Booking ACP-1234",
  issueDate: "2096-05-01",
  dueDate: "2096-05-08",
  currency: "GBP",
  lines: [
    { description: "Brake pads", quantity: "1.000", unitPricePence: 12000, lineTotalPence: 12000, taxPence: 0 },
    { description: "Labour", quantity: "1.500", unitPricePence: 4000, lineTotalPence: 6000, taxPence: 0 },
  ],
  discountPence: 1000,
  taxPence: 0,
  totalPence: 17000,
});

const PAYMENT = (invoiceRemoteId: string, contactRemoteId: string): PaymentInput => ({
  localId: "31360000-0000-4000-8000-000000000001",
  invoiceRemoteId,
  contactRemoteId,
  amountPence: 5000,
  paidOn: "2096-05-02",
  reference: "Card ending 4242",
  method: "card",
});

const CONTACT = { localId: "11111111-1111-4111-8111-111111111111", name: "Jo Bloggs", email: "jo@example.test", phone: "+447700900123" };

type Harness = {
  name: string;
  fixture: Fixture;
  tenantId: string;
  make: (fetcher: FetchLike) => AccountingProvider;
  happyRoutes: Route[];
  /** Route the invoice push to an error fixture. */
  invoiceRoute: (response: string) => Route;
  callbackParams: URLSearchParams;
  build: {
    invoice: (context: ProviderContext, invoice: InvoiceInput) => unknown;
    payment: (context: ProviderContext, payment: PaymentInput) => unknown;
  };
  contactId: string;
  invoiceId: string;
};

const has = (fragment: string) => (url: string) => url.includes(fragment);
const ENV = (prefix: string) => ({ [`${prefix}_CLIENT_ID`]: "client-id", [`${prefix}_CLIENT_SECRET`]: "client-secret" });

const HARNESSES: Harness[] = [
  {
    name: "xero",
    fixture: xeroFixture as Fixture,
    tenantId: "70784a63-d24b-46a9-a4db-0e70a274b056",
    make: (fetcher) => createXeroProvider({ env: ENV("XERO"), fetch: fetcher, now: () => NOW }),
    happyRoutes: [
      { method: "POST", test: has("identity.xero.com/connect/token"), response: "token" },
      { method: "GET", test: has("api.xero.com/connections"), response: "connections" },
      { method: "GET", test: has("/Contacts?"), response: "contactsEmpty" },
      { method: "POST", test: has("/Contacts"), response: "contactCreated" },
      { method: "POST", test: has("/Invoices"), response: "invoiceCreated" },
      { method: "PUT", test: has("/Payments"), response: "paymentCreated" },
      { method: "POST", test: has("connect/revocation"), response: "contactsEmpty" },
    ],
    invoiceRoute: (response) => ({ method: "POST", test: has("/Invoices"), response }),
    callbackParams: new URLSearchParams(),
    build: { invoice: (c, i) => xeroRequests.pushInvoice(c, i), payment: (c, p) => xeroRequests.pushPayment(c, p) },
    contactId: "3ff6d40c-af9a-40a3-89ce-3c1556a25591",
    invoiceId: "243216c5-369e-4056-ac67-05388f86dc81",
  },
  {
    name: "quickbooks",
    fixture: quickbooksFixture as Fixture,
    tenantId: quickbooksFixture.callbackRealmId,
    make: (fetcher) => createQuickBooksProvider({ env: ENV("QUICKBOOKS"), fetch: fetcher, now: () => NOW }),
    happyRoutes: [
      { method: "POST", test: has("oauth2/v1/tokens/bearer"), response: "token" },
      { method: "GET", test: has("/companyinfo/"), response: "companyInfo" },
      { method: "GET", test: has("/query?"), response: "queryEmpty" },
      { method: "POST", test: has("/customer?"), response: "customerCreated" },
      { method: "POST", test: has("/invoice?"), response: "invoiceCreated" },
      { method: "POST", test: has("/payment?"), response: "paymentCreated" },
      { method: "POST", test: has("tokens/revoke"), response: "queryEmpty" },
    ],
    invoiceRoute: (response) => ({ method: "POST", test: has("/invoice?"), response }),
    callbackParams: new URLSearchParams({ realmId: quickbooksFixture.callbackRealmId }),
    build: {
      invoice: (c, i) => quickbooksRequests.pushInvoice({ apiBase: "https://sandbox-quickbooks.api.intuit.com" }, c, i),
      payment: (c, p) => quickbooksRequests.pushPayment({ apiBase: "https://sandbox-quickbooks.api.intuit.com" }, c, p),
    },
    contactId: "58",
    invoiceId: "130",
  },
  {
    name: "sage",
    fixture: sageFixture as Fixture,
    tenantId: "8a53bc8d5d6c4ad6a5ba4f2d9c3a1e01",
    make: (fetcher) => createSageProvider({ env: ENV("SAGE"), fetch: fetcher, now: () => NOW }),
    happyRoutes: [
      { method: "POST", test: has("oauth.accounting.sage.com/token"), response: "token" },
      { method: "GET", test: has("/v3.1/businesses"), response: "businesses" },
      { method: "GET", test: has("/v3.1/contacts?"), response: "listEmpty" },
      { method: "POST", test: has("/v3.1/contacts"), response: "contactCreated" },
      { method: "GET", test: has("/v3.1/ledger_accounts"), response: "ledgerAccounts" },
      { method: "GET", test: has("/v3.1/bank_accounts"), response: "bankAccounts" },
      { method: "GET", test: has("/v3.1/sales_invoices?"), response: "listEmpty" },
      { method: "POST", test: has("/v3.1/sales_invoices"), response: "invoiceCreated" },
      { method: "POST", test: has("/v3.1/contact_payments"), response: "paymentCreated" },
      { method: "POST", test: has("oauth.accounting.sage.com/revoke"), response: "listEmpty" },
    ],
    invoiceRoute: (response) => ({ method: "POST", test: has("/v3.1/sales_invoices"), response }),
    callbackParams: new URLSearchParams(),
    build: {
      invoice: (c, i) => sageRequests.pushInvoice(c, i, "9a994b92267a11e797950a57719b2edb"),
      payment: (c, p) => sageRequests.pushPayment(c, p, "27ec0d2f42a34a1a8f6e6d9a7a8b9c0d"),
    },
    contactId: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
    invoiceId: "5f1a2b3c4d5e6f708192a3b4c5d6e7f8",
  },
];

function tokensFrom(harness: Harness): TokenSet {
  const body = pick(harness.fixture.responses, "token").body as Record<string, string>;
  return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token), expiresAt: new Date(NOW.getTime() + 600_000), refreshExpiresAt: null, scopes: [], tenantHint: harness.tenantId };
}

describe.each(HARNESSES)("$name adapter contract", (harness) => {
  let recorded: Recorded[];
  let provider: AccountingProvider;
  const context = (key: string): ProviderContext => ({ tokens: tokensFrom(harness), tenantId: harness.tenantId, settings: {}, idempotencyKey: key });

  beforeEach(() => {
    recorded = [];
    provider = harness.make(fixtureFetch(harness.fixture, harness.happyRoutes, recorded));
  });

  it("builds the authorize URL with state, redirect URI and client id", () => {
    const url = new URL(provider.authorizeUrl({ state: "state-123", codeChallenge: "challenge-abc", redirectUri: REDIRECT }));
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(provider.scopes.join(" "));
    if (harness.name === "xero") {
      expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    }
  });

  it("exchanges the code and maps the token response", async () => {
    const tokens = await provider.exchangeCode({ code: "code-1", codeVerifier: "verifier-1", redirectUri: REDIRECT, callbackParams: harness.callbackParams });
    const body = pick(harness.fixture.responses, "token").body as Record<string, string | number>;
    expect(tokens.accessToken).toBe(body.access_token);
    expect(tokens.refreshToken).toBe(body.refresh_token);
    expect(tokens.expiresAt.getTime()).toBe(NOW.getTime() + Number(body.expires_in) * 1000);
    const form = new URLSearchParams(recorded[0]!.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    if (harness.name === "xero") expect(form.get("code_verifier")).toBe("verifier-1");
    // The client secret goes in Basic auth or the form, never the URL.
    expect(recorded[0]!.url).not.toContain("client-secret");
  });

  it("lists organisations", async () => {
    const tokens = await provider.exchangeCode({ code: "code-1", codeVerifier: "v", redirectUri: REDIRECT, callbackParams: harness.callbackParams });
    const tenants = await provider.listTenants(tokens);
    expect(tenants.length).toBeGreaterThanOrEqual(1);
    expect(tenants[0]!.id).toBe(harness.tenantId);
    expect(tenants[0]!.name.length).toBeGreaterThan(0);
  });

  it("creates a contact when none matches", async () => {
    const { remoteId } = await provider.upsertContact(context("af-contact-test"), CONTACT);
    expect(remoteId).toBe(harness.contactId);
    const created = recorded.find((request) => request.method === "POST" && /contacts|customer/i.test(request.url));
    expect(created?.body).toContain("Jo Bloggs");
  });

  it("builds the invoice exactly as recorded and maps the created id", async () => {
    const expected = pick(harness.fixture.requests, "invoice");
    const built = harness.build.invoice(context("af-invoice-test"), INVOICE(harness.contactId)) as { method: string; url: string; headers: Record<string, string>; body: unknown };
    expect(built.method).toBe(expected.method);
    expect(built.url).toBe(expected.url);
    expect(built.headers).toEqual(expected.headers);
    expect(built.body).toEqual(expected.body);
    const { remoteId } = await provider.pushInvoice(context("af-invoice-test"), INVOICE(harness.contactId));
    expect(remoteId).toBe(harness.invoiceId);
  });

  it("builds the payment exactly as recorded and maps the created id", async () => {
    const expected = pick(harness.fixture.requests, "payment");
    const built = harness.build.payment(context("af-payment-test"), PAYMENT(harness.invoiceId, harness.contactId)) as { method: string; url: string; headers: Record<string, string>; body: unknown };
    expect(built).toEqual({ method: expected.method, url: expected.url, headers: expected.headers, body: expected.body });
    const { remoteId } = await provider.pushPayment(context("af-payment-test"), PAYMENT(harness.invoiceId, harness.contactId));
    expect(remoteId.length).toBeGreaterThan(0);
  });

  it.each([
    ["rateLimited", "RATE_LIMITED"],
    ["unauthorised", "AUTH_EXPIRED"],
    ["validation", "VALIDATION"],
  ] as const)("maps the %s response to %s", async (response, code) => {
    provider = harness.make(fixtureFetch(harness.fixture, [harness.invoiceRoute(response), ...harness.happyRoutes], recorded));
    const error = await provider.pushInvoice(context("k"), INVOICE(harness.contactId)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountingError);
    expect((error as AccountingError).code).toBe(code);
    if (code === "RATE_LIMITED") expect((error as AccountingError).retryAfterSeconds).toBe(7);
    // Provider text never reaches our error message.
    expect((error as Error).message).not.toMatch(/Account code|Required param|can't be blank|TokenExpired/);
  });

  it("maps a refused refresh token to AUTH_EXPIRED (reconnect needed)", async () => {
    provider = harness.make(fixtureFetch(harness.fixture, [{ method: "POST", test: () => true, response: "tokenInvalidGrant" }], recorded));
    const error = await provider.refresh(tokensFrom(harness)).catch((caught: unknown) => caught);
    expect((error as AccountingError).code).toBe("AUTH_EXPIRED");
  });

  it("maps a server error to PROVIDER_UNAVAILABLE and a network failure to NETWORK", async () => {
    provider = harness.make(async () => new Response("oops", { status: 503 }));
    expect(((await provider.pushInvoice(context("k"), INVOICE(harness.contactId)).catch((e: unknown) => e)) as AccountingError).code).toBe("PROVIDER_UNAVAILABLE");
    provider = harness.make(async () => {
      throw new TypeError("fetch failed");
    });
    expect(((await provider.pushInvoice(context("k"), INVOICE(harness.contactId)).catch((e: unknown) => e)) as AccountingError).code).toBe("NETWORK");
  });

  it("reports configuration required without client credentials", () => {
    const unconfigured = harness.name === "xero" ? createXeroProvider({ env: {} }) : harness.name === "quickbooks" ? createQuickBooksProvider({ env: {} }) : createSageProvider({ env: {} });
    expect(unconfigured.configured).toBe(false);
    expect(() => unconfigured.authorizeUrl({ state: "s", codeChallenge: "c", redirectUri: REDIRECT })).toThrow(/CONFIGURATION_REQUIRED/);
  });
});

describe("xero specifics", () => {
  it("reuses an existing contact found by contact number", async () => {
    const recorded: Recorded[] = [];
    const provider = createXeroProvider({ env: ENV("XERO"), fetch: fixtureFetch(xeroFixture as Fixture, [{ method: "GET", test: has("/Contacts?"), response: "contactCreated" }], recorded) });
    const { remoteId } = await provider.upsertContact({ tokens: tokensFrom(HARNESSES[0]!), tenantId: "t", settings: {}, idempotencyKey: "k" }, CONTACT);
    expect(remoteId).toBe("3ff6d40c-af9a-40a3-89ce-3c1556a25591");
    expect(recorded).toHaveLength(1);
    expect(decodeURIComponent(recorded[0]!.url)).toContain('ContactNumber=="AF-11111111-1111-4111-8111-111111111111"');
  });
});

describe("quickbooks specifics", () => {
  it("needs the realmId from the callback", async () => {
    const provider = createQuickBooksProvider({ env: ENV("QUICKBOOKS"), fetch: fixtureFetch(quickbooksFixture as Fixture, HARNESSES[1]!.happyRoutes, []) });
    const error = await provider.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: REDIRECT, callbackParams: new URLSearchParams() }).catch((e: unknown) => e);
    expect((error as AccountingError).code).toBe("VALIDATION");
  });

  it("escapes quotes in the customer query", () => {
    const request = quickbooksRequests.findCustomer({ apiBase: "https://x" }, { tokens: tokensFrom(HARNESSES[1]!), tenantId: "1" }, "O'Brien");
    expect(new URL(request.url).searchParams.get("query")).toBe("select Id from Customer where DisplayName = 'O\\'Brien'");
  });
});

describe("sage specifics", () => {
  it("finds an invoice already sent under the same number instead of creating it twice", async () => {
    const recorded: Recorded[] = [];
    const provider = createSageProvider({ env: ENV("SAGE"), fetch: fixtureFetch(sageFixture as Fixture, [{ method: "GET", test: has("/sales_invoices?"), response: "ledgerAccounts" }], recorded) });
    const { remoteId } = await provider.pushInvoice({ tokens: tokensFrom(HARNESSES[2]!), tenantId: "b", settings: {}, idempotencyKey: "k" }, INVOICE("c"));
    expect(remoteId).toBe("9a994b92267a11e797950a57719b2edb");
    expect(recorded.every((request) => request.method === "GET")).toBe(true);
  });
});

describe("fake provider contract", () => {
  beforeEach(() => resetFakeAccountingStore());
  const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

  it("runs the OAuth round trip with PKCE", async () => {
    const provider = createFakeProvider({ now: () => NOW });
    const url = new URL(provider.authorizeUrl({ state: "s1", codeChallenge: challenge("verifier"), redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("s1");
    const code = url.searchParams.get("code")!;
    await expect(provider.exchangeCode({ code, codeVerifier: "wrong", redirectUri: REDIRECT, callbackParams: url.searchParams })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    const tokens = await provider.exchangeCode({ code, codeVerifier: "verifier", redirectUri: REDIRECT, callbackParams: url.searchParams });
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect((await provider.listTenants(tokens)).length).toBe(2);
    const refreshed = await provider.refresh(tokens);
    // Refresh tokens rotate: the old one is refused afterwards.
    await expect(provider.refresh(tokens)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    await provider.revoke(refreshed);
    await expect(provider.listTenants(refreshed)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("creates contacts, invoices and payments idempotently and enforces balances", async () => {
    const provider = createFakeProvider({ now: () => NOW });
    const tokens = await provider.exchangeCode({ code: `fake.${challenge("v")}`, codeVerifier: "v", redirectUri: REDIRECT, callbackParams: new URLSearchParams() });
    const ctx = (key: string): ProviderContext => ({ tokens, tenantId: "fake-org-1", settings: {}, idempotencyKey: key });
    const contact = await provider.upsertContact(ctx("c1"), CONTACT);
    expect((await provider.upsertContact(ctx("c1-again"), CONTACT)).remoteId).toBe(contact.remoteId);
    const invoice = await provider.pushInvoice(ctx("i1"), INVOICE(contact.remoteId));
    expect((await provider.pushInvoice(ctx("i1"), INVOICE(contact.remoteId))).remoteId).toBe(invoice.remoteId);
    const payment = await provider.pushPayment(ctx("p1"), PAYMENT(invoice.remoteId, contact.remoteId));
    expect((await provider.pushPayment(ctx("p1"), PAYMENT(invoice.remoteId, contact.remoteId))).remoteId).toBe(payment.remoteId);
    await expect(provider.pushPayment(ctx("p2"), { ...PAYMENT(invoice.remoteId, contact.remoteId), amountPence: 20000 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(provider.pushPayment(ctx("p3"), PAYMENT("nope", contact.remoteId))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(provider.pushInvoice(ctx("i2"), { ...INVOICE(contact.remoteId), totalPence: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("has the failure switches the sync engine and e2e use", async () => {
    const provider = createFakeProvider({ now: () => NOW });
    const tokens = await provider.exchangeCode({ code: `fake.${challenge("v")}`, codeVerifier: "v", redirectUri: REDIRECT, callbackParams: new URLSearchParams() });
    const ctx = (key: string): ProviderContext => ({ tokens, tenantId: "fake-org-1", settings: {}, idempotencyKey: key });
    const failOnce = await provider.upsertContact(ctx("a"), { ...CONTACT, localId: "a", name: "Fail Once Ltd" });
    await expect(provider.pushInvoice(ctx("x"), INVOICE(failOnce.remoteId))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(provider.pushInvoice(ctx("x"), INVOICE(failOnce.remoteId))).resolves.toBeTruthy();
    const limited = await provider.upsertContact(ctx("b"), { ...CONTACT, localId: "b", name: "Rate Limit Ltd" });
    await expect(provider.pushInvoice(ctx("y"), INVOICE(limited.remoteId))).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 1 });
    const expired = await provider.upsertContact(ctx("c"), { ...CONTACT, localId: "c", name: "Auth Expired Ltd" });
    await expect(provider.pushInvoice(ctx("z"), INVOICE(expired.remoteId))).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("provider registry", () => {
  it("serves every choice with the fake in fake mode (the default)", () => {
    expect(getAccountingProvider("xero", { env: {} }).name).toBe("Xero (test mode)");
    expect(getAccountingProvider("sage", { env: { ACCOUNTING_PROVIDER_MODE: "fake" } }).configured).toBe(true);
  });

  it("uses the real adapters in live mode, unconfigured without credentials", () => {
    const xero = getAccountingProvider("xero", { env: { ACCOUNTING_PROVIDER_MODE: "live" } });
    expect(xero.name).toBe("Xero");
    expect(xero.configured).toBe(false);
    expect(getAccountingProvider("quickbooks", { env: { ACCOUNTING_PROVIDER_MODE: "live", ...ENV("QUICKBOOKS") } }).configured).toBe(true);
  });
});
