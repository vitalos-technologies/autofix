// QuickBooks Online adapter (P5.10). Intuit OAuth 2 (appcenter.intuit.com, oauth.platform.intuit.com)
// and the Accounting API v3 (Customer, Invoice, Payment) per developer.intuit.com. The company
// (realmId) comes back on the callback URL; `requestid` makes creates idempotent; errors come as
// `{Fault: {Error: [...], type}}`. Sandbox by default (QUICKBOOKS_ENVIRONMENT=production for live).
// Request builders and mappers are pure and exported for the contract tests.

import { asArray, asRecord, basicAuth, bearer, ensureOk, mapTokenError, mapTokenResponse, requireString, send, type FetchLike, type ProviderRequest, type ProviderResponse } from "../http";
import {
  AccountingError,
  penceToNumber,
  type AccountingProvider,
  type AuthorizeInput,
  type ContactInput,
  type ExchangeInput,
  type InvoiceInput,
  type PaymentInput,
  type ProviderContext,
  type TokenSet,
} from "../types";

export const QUICKBOOKS_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QUICKBOOKS_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QUICKBOOKS_SANDBOX_API = "https://sandbox-quickbooks.api.intuit.com";
export const QUICKBOOKS_PRODUCTION_API = "https://quickbooks.api.intuit.com";
export const QUICKBOOKS_SCOPES = ["com.intuit.quickbooks.accounting"] as const;
export const QUICKBOOKS_MINOR_VERSION = "75";
export const QUICKBOOKS_DEFAULT_ITEM = "1";

export type QuickBooksCredentials = { clientId: string; clientSecret: string; apiBase: string };

function companyUrl(apiBase: string, realmId: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(`${apiBase}/v3/company/${encodeURIComponent(realmId)}/${path}`);
  url.searchParams.set("minorversion", QUICKBOOKS_MINOR_VERSION);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** QuickBooks query strings quote with single quotes; a quote inside is escaped with a backslash. */
export function quickbooksQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const quickbooksRequests = {
  authorizeUrl(credentials: Pick<QuickBooksCredentials, "clientId">, input: AuthorizeInput): string {
    const url = new URL(QUICKBOOKS_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      response_type: "code",
      scope: QUICKBOOKS_SCOPES.join(" "),
      redirect_uri: input.redirectUri,
      state: input.state,
    }).toString();
    return url.toString();
  },
  exchange(credentials: QuickBooksCredentials, input: Pick<ExchangeInput, "code" | "redirectUri">): ProviderRequest {
    return {
      method: "POST",
      url: QUICKBOOKS_TOKEN_URL,
      headers: { Authorization: basicAuth(credentials.clientId, credentials.clientSecret) },
      form: { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri },
    };
  },
  refresh(credentials: QuickBooksCredentials, refreshToken: string): ProviderRequest {
    return {
      method: "POST",
      url: QUICKBOOKS_TOKEN_URL,
      headers: { Authorization: basicAuth(credentials.clientId, credentials.clientSecret) },
      form: { grant_type: "refresh_token", refresh_token: refreshToken },
    };
  },
  revoke(credentials: QuickBooksCredentials, token: string): ProviderRequest {
    return { method: "POST", url: QUICKBOOKS_REVOKE_URL, headers: { Authorization: basicAuth(credentials.clientId, credentials.clientSecret) }, body: { token } };
  },
  companyInfo(credentials: Pick<QuickBooksCredentials, "apiBase">, accessToken: string, realmId: string): ProviderRequest {
    return { method: "GET", url: companyUrl(credentials.apiBase, realmId, `companyinfo/${encodeURIComponent(realmId)}`), headers: { Authorization: bearer(accessToken) } };
  },
  findCustomer(credentials: Pick<QuickBooksCredentials, "apiBase">, context: Pick<ProviderContext, "tokens" | "tenantId">, displayName: string): ProviderRequest {
    return {
      method: "GET",
      url: companyUrl(credentials.apiBase, context.tenantId, "query", { query: `select Id from Customer where DisplayName = ${quickbooksQuote(displayName)}` }),
      headers: { Authorization: bearer(context.tokens.accessToken) },
    };
  },
  createCustomer(credentials: Pick<QuickBooksCredentials, "apiBase">, context: Pick<ProviderContext, "tokens" | "tenantId" | "idempotencyKey">, contact: ContactInput): ProviderRequest {
    return {
      method: "POST",
      url: companyUrl(credentials.apiBase, context.tenantId, "customer", { requestid: context.idempotencyKey }),
      headers: { Authorization: bearer(context.tokens.accessToken) },
      body: {
        DisplayName: contact.name.slice(0, 500),
        ...(contact.email ? { PrimaryEmailAddr: { Address: contact.email } } : {}),
        ...(contact.phone ? { Mobile: { FreeFormNumber: contact.phone } } : {}),
      },
    };
  },
  pushInvoice(credentials: Pick<QuickBooksCredentials, "apiBase">, context: ProviderContext, invoice: InvoiceInput): ProviderRequest {
    const itemId = context.settings.itemId ?? QUICKBOOKS_DEFAULT_ITEM;
    const taxCode = context.settings.taxCodeId;
    const lines: Record<string, unknown>[] = invoice.lines.map((line, index) => ({
      LineNum: index + 1,
      DetailType: "SalesItemLineDetail",
      Amount: penceToNumber(line.lineTotalPence),
      Description: line.description,
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: Number(line.quantity),
        UnitPrice: penceToNumber(line.unitPricePence),
        ...(taxCode ? { TaxCodeRef: { value: taxCode } } : {}),
      },
    }));
    if (invoice.discountPence > 0) {
      lines.push({ DetailType: "DiscountLineDetail", Amount: penceToNumber(invoice.discountPence), DiscountLineDetail: { PercentBased: false } });
    }
    return {
      method: "POST",
      url: companyUrl(credentials.apiBase, context.tenantId, "invoice", { requestid: context.idempotencyKey }),
      headers: { Authorization: bearer(context.tokens.accessToken) },
      body: {
        CustomerRef: { value: invoice.contactRemoteId },
        DocNumber: invoice.number.slice(0, 21),
        TxnDate: invoice.issueDate,
        DueDate: invoice.dueDate,
        CurrencyRef: { value: invoice.currency },
        ...(invoice.reference ? { PrivateNote: invoice.reference } : {}),
        Line: lines,
      },
    };
  },
  pushPayment(credentials: Pick<QuickBooksCredentials, "apiBase">, context: ProviderContext, payment: PaymentInput): ProviderRequest {
    return {
      method: "POST",
      url: companyUrl(credentials.apiBase, context.tenantId, "payment", { requestid: context.idempotencyKey }),
      headers: { Authorization: bearer(context.tokens.accessToken) },
      body: {
        CustomerRef: { value: payment.contactRemoteId },
        TotalAmt: penceToNumber(payment.amountPence),
        TxnDate: payment.paidOn,
        ...(payment.reference ? { PaymentRefNum: payment.reference.slice(0, 21) } : {}),
        Line: [{ Amount: penceToNumber(payment.amountPence), LinkedTxn: [{ TxnId: payment.invoiceRemoteId, TxnType: "Invoice" }] }],
      },
    };
  },
};

export const quickbooksMappers = {
  companyName(body: unknown): string {
    const name = asRecord(asRecord(body).CompanyInfo).CompanyName;
    return typeof name === "string" && name ? name : "QuickBooks company";
  },
  queryCustomerId(body: unknown): string | null {
    const first = asRecord(asArray(asRecord(asRecord(body).QueryResponse).Customer)[0]);
    return typeof first.Id === "string" ? first.Id : null;
  },
  customerId(body: unknown): string {
    return requireString(asRecord(asRecord(body).Customer).Id, "Customer.Id");
  },
  invoiceId(body: unknown): string {
    return requireString(asRecord(asRecord(body).Invoice).Id, "Invoice.Id");
  },
  paymentId(body: unknown): string {
    return requireString(asRecord(asRecord(body).Payment).Id, "Payment.Id");
  },
  /** Fault types on top of the HTTP mapping: AuthenticationFault → reconnect, ValidationFault → validation. */
  error(response: ProviderResponse, now?: Date): AccountingError | null {
    const fault = asRecord(asRecord(response.body).Fault);
    const type = fault.type;
    if (response.status >= 200 && response.status < 300 && !type) return null;
    if (type === "AUTHENTICATION" || type === "AuthenticationFault") return new AccountingError("AUTH_EXPIRED", { status: response.status, detail: "AuthenticationFault" });
    if (type === "ValidationFault") return new AccountingError("VALIDATION", { status: response.status, detail: "ValidationFault" });
    if (response.status === 429 || type === "ThrottleExceeded") {
      return ensureOkError({ ...response, status: 429 }, now);
    }
    return ensureOkError(response, now) ?? new AccountingError("UNEXPECTED_RESPONSE", { status: response.status, detail: String(type ?? "fault").slice(0, 40) });
  },
};

function ensureOkError(response: ProviderResponse, now?: Date): AccountingError | null {
  try {
    ensureOk(response, now);
    return null;
  } catch (error) {
    return error as AccountingError;
  }
}

/** Fault code 6240: "Duplicate Name Exists Error" (DisplayName must be unique). */
export function isDuplicateNameFault(body: unknown): boolean {
  return asArray(asRecord(asRecord(body).Fault).Error).some((entry) => String(asRecord(entry).code) === "6240");
}

export function createQuickBooksProvider(options: { env?: Readonly<Record<string, string | undefined>>; fetch?: FetchLike; now?: () => Date } = {}): AccountingProvider {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const clientId = env.QUICKBOOKS_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET?.trim() ?? "";
  const configured = clientId.length > 0 && clientSecret.length > 0;
  const credentials: QuickBooksCredentials = {
    clientId,
    clientSecret,
    apiBase: env.QUICKBOOKS_ENVIRONMENT === "production" ? QUICKBOOKS_PRODUCTION_API : QUICKBOOKS_SANDBOX_API,
  };

  function requireConfigured() {
    if (!configured) throw new AccountingError("CONFIGURATION_REQUIRED", { detail: "QUICKBOOKS_CLIENT_ID/QUICKBOOKS_CLIENT_SECRET" });
  }

  function check(response: ProviderResponse) {
    const error = quickbooksMappers.error(response, now());
    if (error) throw error;
    return response;
  }

  async function token(request: ProviderRequest, tenantHint: string | null): Promise<TokenSet> {
    requireConfigured();
    const at = now();
    const response = await send(fetcher, request);
    if (response.status < 200 || response.status >= 300) throw mapTokenError(response, at);
    return { ...mapTokenResponse(response.body, at, QUICKBOOKS_SCOPES), tenantHint };
  }

  return {
    id: "quickbooks",
    name: "QuickBooks",
    configured,
    scopes: QUICKBOOKS_SCOPES,
    authorizeUrl(input) {
      requireConfigured();
      return quickbooksRequests.authorizeUrl(credentials, input);
    },
    exchangeCode(input) {
      const realmId = input.callbackParams.get("realmId");
      if (!realmId || !/^\d{1,30}$/.test(realmId)) throw new AccountingError("VALIDATION", { detail: "missing realmId" });
      return token(quickbooksRequests.exchange(credentials, input), realmId);
    },
    refresh(tokens) {
      if (!tokens.refreshToken) throw new AccountingError("AUTH_EXPIRED", { detail: "no refresh token" });
      return token(quickbooksRequests.refresh(credentials, tokens.refreshToken), tokens.tenantHint ?? null);
    },
    async revoke(tokens) {
      requireConfigured();
      ensureOk(await send(fetcher, quickbooksRequests.revoke(credentials, tokens.refreshToken ?? tokens.accessToken)), now());
    },
    async listTenants(tokens) {
      if (!tokens.tenantHint) return [];
      const response = check(await send(fetcher, quickbooksRequests.companyInfo(credentials, tokens.accessToken, tokens.tenantHint)));
      return [{ id: tokens.tenantHint, name: quickbooksMappers.companyName(response.body) }];
    },
    async upsertContact(context, contact) {
      if (contact.remoteId) return { remoteId: contact.remoteId };
      const found = check(await send(fetcher, quickbooksRequests.findCustomer(credentials, context, contact.name)));
      const existing = quickbooksMappers.queryCustomerId(found.body);
      if (existing) return { remoteId: existing };
      const response = await send(fetcher, quickbooksRequests.createCustomer(credentials, context, contact));
      if (isDuplicateNameFault(response.body)) {
        throw new AccountingError("VALIDATION", { status: response.status, detail: "duplicate name" });
      }
      return { remoteId: quickbooksMappers.customerId(check(response).body) };
    },
    async pushInvoice(context, invoice) {
      const response = check(await send(fetcher, quickbooksRequests.pushInvoice(credentials, context, invoice)));
      return { remoteId: quickbooksMappers.invoiceId(response.body) };
    },
    async pushPayment(context, payment) {
      const response = check(await send(fetcher, quickbooksRequests.pushPayment(credentials, context, payment)));
      return { remoteId: quickbooksMappers.paymentId(response.body) };
    },
  };
}
