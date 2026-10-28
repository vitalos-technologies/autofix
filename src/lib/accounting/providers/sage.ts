// Sage Business Cloud Accounting adapter (P5.10), API v3.1 (developer.sage.com/accounting).
// OAuth 2 via www.sageone.com (consent) and oauth.accounting.sage.com (token, revoke; access tokens
// last 5 minutes, refresh tokens rotate). The business is chosen with the X-Business header.
// Contacts, sales_invoices and contact_payments (CUSTOMER_RECEIPT allocated to the invoice).
// Errors come as `[{"$severity","$dataCode","$message","$source"}]`. When no ledger or bank account is
// set on the connection, the first sales ledger account and first bank account are looked up.

import { asArray, asRecord, bearer, ensureOk, mapTokenError, mapTokenResponse, requireString, send, type FetchLike, type ProviderRequest, type ProviderResponse } from "../http";
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

export const SAGE_AUTHORIZE_URL = "https://www.sageone.com/oauth2/auth/central";
export const SAGE_TOKEN_URL = "https://oauth.accounting.sage.com/token";
export const SAGE_REVOKE_URL = "https://oauth.accounting.sage.com/revoke";
export const SAGE_API = "https://api.accounting.sage.com/v3.1";
export const SAGE_SCOPES = ["full_access"] as const;
export const SAGE_NO_TAX_RATE = "GB_NO_TAX";

export type SageCredentials = { clientId: string; clientSecret: string };

function sageHeaders(context: Pick<ProviderContext, "tokens" | "tenantId">): Record<string, string> {
  return { Authorization: bearer(context.tokens.accessToken), "X-Business": context.tenantId };
}

export function sageContactReference(localId: string): string {
  // Contact references are at most 8 characters in Sage UK.
  return `AF${localId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export const sageRequests = {
  authorizeUrl(credentials: Pick<SageCredentials, "clientId">, input: AuthorizeInput): string {
    const url = new URL(SAGE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      filter: "apiv3.1",
      response_type: "code",
      client_id: credentials.clientId,
      redirect_uri: input.redirectUri,
      scope: SAGE_SCOPES.join(" "),
      state: input.state,
      country: "gb",
    }).toString();
    return url.toString();
  },
  exchange(credentials: SageCredentials, input: Pick<ExchangeInput, "code" | "redirectUri">): ProviderRequest {
    return {
      method: "POST",
      url: SAGE_TOKEN_URL,
      headers: {},
      form: { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: credentials.clientId, client_secret: credentials.clientSecret },
    };
  },
  refresh(credentials: SageCredentials, refreshToken: string): ProviderRequest {
    return {
      method: "POST",
      url: SAGE_TOKEN_URL,
      headers: {},
      form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: credentials.clientId, client_secret: credentials.clientSecret },
    };
  },
  revoke(credentials: SageCredentials, token: string): ProviderRequest {
    return { method: "POST", url: SAGE_REVOKE_URL, headers: {}, form: { token, client_id: credentials.clientId, client_secret: credentials.clientSecret } };
  },
  businesses(accessToken: string): ProviderRequest {
    return { method: "GET", url: `${SAGE_API}/businesses`, headers: { Authorization: bearer(accessToken) } };
  },
  findContact(context: Pick<ProviderContext, "tokens" | "tenantId">, localId: string): ProviderRequest {
    const url = new URL(`${SAGE_API}/contacts`);
    url.searchParams.set("contact_type_id", "CUSTOMER");
    url.searchParams.set("search", sageContactReference(localId));
    return { method: "GET", url: url.toString(), headers: sageHeaders(context) };
  },
  createContact(context: Pick<ProviderContext, "tokens" | "tenantId">, contact: ContactInput): ProviderRequest {
    return {
      method: "POST",
      url: `${SAGE_API}/contacts`,
      headers: sageHeaders(context),
      body: {
        contact: {
          name: contact.name.slice(0, 100),
          contact_type_ids: ["CUSTOMER"],
          reference: sageContactReference(contact.localId),
          ...(contact.email || contact.phone
            ? { main_contact_person: { ...(contact.email ? { email: contact.email } : {}), ...(contact.phone ? { mobile: contact.phone } : {}) } }
            : {}),
        },
      },
    };
  },
  /** Sage has no idempotency header: an invoice already sent under our number is found first. */
  findInvoice(context: Pick<ProviderContext, "tokens" | "tenantId">, number: string): ProviderRequest {
    const url = new URL(`${SAGE_API}/sales_invoices`);
    url.searchParams.set("search", number);
    url.searchParams.set("items_per_page", "1");
    return { method: "GET", url: url.toString(), headers: sageHeaders(context) };
  },
  salesLedgerAccounts(context: Pick<ProviderContext, "tokens" | "tenantId">): ProviderRequest {
    return { method: "GET", url: `${SAGE_API}/ledger_accounts?visible_in=sales&items_per_page=1`, headers: sageHeaders(context) };
  },
  bankAccounts(context: Pick<ProviderContext, "tokens" | "tenantId">): ProviderRequest {
    return { method: "GET", url: `${SAGE_API}/bank_accounts?items_per_page=1`, headers: sageHeaders(context) };
  },
  pushInvoice(context: ProviderContext, invoice: InvoiceInput, ledgerAccountId: string): ProviderRequest {
    const lines: Record<string, unknown>[] = invoice.lines.map((line) => ({
      description: line.description,
      ledger_account_id: ledgerAccountId,
      quantity: Number(line.quantity),
      unit_price: penceToNumber(line.unitPricePence),
      net_amount: penceToNumber(line.lineTotalPence),
      tax_rate_id: SAGE_NO_TAX_RATE,
      tax_amount: penceToNumber(line.taxPence),
    }));
    return {
      method: "POST",
      url: `${SAGE_API}/sales_invoices`,
      headers: sageHeaders(context),
      body: {
        sales_invoice: {
          contact_id: invoice.contactRemoteId,
          date: invoice.issueDate,
          due_date: invoice.dueDate,
          reference: invoice.number,
          ...(invoice.reference ? { notes: invoice.reference } : {}),
          currency_id: invoice.currency,
          ...(invoice.discountPence > 0 ? { total_discount_amount: penceToNumber(invoice.discountPence) } : {}),
          invoice_lines: lines,
        },
      },
    };
  },
  pushPayment(context: ProviderContext, payment: PaymentInput, bankAccountId: string): ProviderRequest {
    return {
      method: "POST",
      url: `${SAGE_API}/contact_payments`,
      headers: sageHeaders(context),
      body: {
        contact_payment: {
          transaction_type_id: "CUSTOMER_RECEIPT",
          contact_id: payment.contactRemoteId,
          bank_account_id: bankAccountId,
          date: payment.paidOn,
          total_amount: penceToNumber(payment.amountPence),
          ...(payment.reference ? { reference: payment.reference.slice(0, 25) } : {}),
          allocated_artefacts: [{ artefact_id: payment.invoiceRemoteId, amount: penceToNumber(payment.amountPence) }],
        },
      },
    };
  },
};

export const sageMappers = {
  businesses(body: unknown) {
    const rows = Array.isArray(body) ? body : asArray(asRecord(body).$items);
    return rows.map(asRecord).map((row) => ({ id: requireString(row.id, "business id"), name: typeof row.name === "string" ? row.name : typeof row.displayed_as === "string" ? row.displayed_as : "Sage business" }));
  },
  firstItemId(body: unknown): string | null {
    const first = asRecord(asArray(asRecord(body).$items)[0]);
    return typeof first.id === "string" ? first.id : null;
  },
  id(body: unknown, what: string): string {
    return requireString(asRecord(body).id, what);
  },
  error(response: ProviderResponse, now?: Date): AccountingError | null {
    if (response.status >= 200 && response.status < 300) return null;
    const first = asRecord(asArray(response.body)[0]);
    const dataCode = first.$dataCode;
    if (response.status === 401 || dataCode === "NotAuthorised" || dataCode === "InvalidToken") return new AccountingError("AUTH_EXPIRED", { status: response.status, detail: "not authorised" });
    if ((response.status === 400 || response.status === 422) && typeof dataCode === "string") return new AccountingError("VALIDATION", { status: response.status, detail: /^[A-Za-z]{1,40}$/.test(dataCode) ? dataCode : "invalid" });
    try {
      ensureOk(response, now);
    } catch (error) {
      return error as AccountingError;
    }
    return null;
  },
};

export function createSageProvider(options: { env?: Readonly<Record<string, string | undefined>>; fetch?: FetchLike; now?: () => Date } = {}): AccountingProvider {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const clientId = env.SAGE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.SAGE_CLIENT_SECRET?.trim() ?? "";
  const configured = clientId.length > 0 && clientSecret.length > 0;
  const credentials = { clientId, clientSecret };
  const lookups = new Map<string, string>();

  function requireConfigured() {
    if (!configured) throw new AccountingError("CONFIGURATION_REQUIRED", { detail: "SAGE_CLIENT_ID/SAGE_CLIENT_SECRET" });
  }

  function check(response: ProviderResponse) {
    const error = sageMappers.error(response, now());
    if (error) throw error;
    return response;
  }

  async function token(request: ProviderRequest): Promise<TokenSet> {
    requireConfigured();
    const at = now();
    const response = await send(fetcher, request);
    if (response.status < 200 || response.status >= 300) throw mapTokenError(response, at);
    return { ...mapTokenResponse(response.body, at, SAGE_SCOPES), tenantHint: null };
  }

  async function lookup(kind: "ledger" | "bank", context: ProviderContext): Promise<string> {
    const set = kind === "ledger" ? context.settings.ledgerAccountId : context.settings.bankAccountId;
    if (set) return set;
    const key = `${context.tenantId}:${kind}`;
    const cached = lookups.get(key);
    if (cached) return cached;
    const response = check(await send(fetcher, kind === "ledger" ? sageRequests.salesLedgerAccounts(context) : sageRequests.bankAccounts(context)));
    const id = sageMappers.firstItemId(response.body);
    if (!id) throw new AccountingError("VALIDATION", { detail: kind === "ledger" ? "no sales ledger account" : "no bank account" });
    lookups.set(key, id);
    return id;
  }

  return {
    id: "sage",
    name: "Sage Accounting",
    configured,
    scopes: SAGE_SCOPES,
    authorizeUrl(input) {
      requireConfigured();
      return sageRequests.authorizeUrl(credentials, input);
    },
    exchangeCode(input) {
      return token(sageRequests.exchange(credentials, input));
    },
    refresh(tokens) {
      if (!tokens.refreshToken) throw new AccountingError("AUTH_EXPIRED", { detail: "no refresh token" });
      return token(sageRequests.refresh(credentials, tokens.refreshToken));
    },
    async revoke(tokens) {
      requireConfigured();
      ensureOk(await send(fetcher, sageRequests.revoke(credentials, tokens.refreshToken ?? tokens.accessToken)), now());
    },
    async listTenants(tokens) {
      return sageMappers.businesses(check(await send(fetcher, sageRequests.businesses(tokens.accessToken))).body);
    },
    async upsertContact(context, contact) {
      if (contact.remoteId) return { remoteId: contact.remoteId };
      const found = sageMappers.firstItemId(check(await send(fetcher, sageRequests.findContact(context, contact.localId))).body);
      if (found) return { remoteId: found };
      return { remoteId: sageMappers.id(check(await send(fetcher, sageRequests.createContact(context, contact))).body, "contact id") };
    },
    async pushInvoice(context, invoice) {
      const existing = sageMappers.firstItemId(check(await send(fetcher, sageRequests.findInvoice(context, invoice.number))).body);
      if (existing) return { remoteId: existing };
      const ledger = await lookup("ledger", context);
      return { remoteId: sageMappers.id(check(await send(fetcher, sageRequests.pushInvoice(context, invoice, ledger))).body, "sales invoice id") };
    },
    async pushPayment(context, payment) {
      const bank = await lookup("bank", context);
      return { remoteId: sageMappers.id(check(await send(fetcher, sageRequests.pushPayment(context, payment, bank))).body, "contact payment id") };
    },
  };
}
