// Xero adapter (P5.10). OAuth 2 authorisation code with PKCE (identity.xero.com), the Connections
// API for organisations (tenants) and the Accounting API (api.xro/2.0) for contacts, invoices and
// payments. Shapes follow developer.xero.com (Contacts, Invoices, Payments; "Rate limits":
// 429 with Retry-After). Request builders and response mappers are pure and exported for the
// contract tests (tests/fixtures/accounting/xero/*.json).

import { asArray, asRecord, basicAuth, bearer, ensureOk, mapTokenError, mapTokenResponse, requireString, send, type FetchLike, type ProviderRequest, type ProviderResponse } from "../http";
import {
  AccountingError,
  penceToNumber,
  type AccountingProvider,
  type AccountingTenant,
  type AuthorizeInput,
  type ContactInput,
  type ExchangeInput,
  type InvoiceInput,
  type PaymentInput,
  type ProviderContext,
  type TokenSet,
} from "../types";

export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_REVOKE_URL = "https://identity.xero.com/connect/revocation";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export const XERO_API = "https://api.xero.com/api.xro/2.0";
export const XERO_SCOPES = ["offline_access", "accounting.transactions", "accounting.contacts"] as const;
export const XERO_DEFAULT_SALES_ACCOUNT = "200";
export const XERO_DEFAULT_BANK_ACCOUNT = "090";

export type XeroCredentials = { clientId: string; clientSecret: string };

export function xeroContactNumber(localId: string): string {
  return `AF-${localId}`.slice(0, 50);
}

export const xeroRequests = {
  authorizeUrl(credentials: Pick<XeroCredentials, "clientId">, input: AuthorizeInput): string {
    const url = new URL(XERO_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: credentials.clientId,
      redirect_uri: input.redirectUri,
      scope: XERO_SCOPES.join(" "),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  },
  exchange(credentials: XeroCredentials, input: Pick<ExchangeInput, "code" | "codeVerifier" | "redirectUri">): ProviderRequest {
    return {
      method: "POST",
      url: XERO_TOKEN_URL,
      headers: { Authorization: basicAuth(credentials.clientId, credentials.clientSecret) },
      form: { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier },
    };
  },
  refresh(credentials: XeroCredentials, refreshToken: string): ProviderRequest {
    return {
      method: "POST",
      url: XERO_TOKEN_URL,
      headers: { Authorization: basicAuth(credentials.clientId, credentials.clientSecret) },
      form: { grant_type: "refresh_token", refresh_token: refreshToken },
    };
  },
  revoke(credentials: XeroCredentials, token: string): ProviderRequest {
    return { method: "POST", url: XERO_REVOKE_URL, headers: { Authorization: basicAuth(credentials.clientId, credentials.clientSecret) }, form: { token } };
  },
  connections(accessToken: string): ProviderRequest {
    return { method: "GET", url: XERO_CONNECTIONS_URL, headers: { Authorization: bearer(accessToken) } };
  },
  findContactByNumber(context: Pick<ProviderContext, "tokens" | "tenantId">, localId: string): ProviderRequest {
    const url = new URL(`${XERO_API}/Contacts`);
    url.searchParams.set("where", `ContactNumber=="${xeroContactNumber(localId)}"`);
    url.searchParams.set("summaryOnly", "true");
    return { method: "GET", url: url.toString(), headers: tenantHeaders(context) };
  },
  findContactByName(context: Pick<ProviderContext, "tokens" | "tenantId">, name: string): ProviderRequest | null {
    if (/["\\]/.test(name)) return null;
    const url = new URL(`${XERO_API}/Contacts`);
    url.searchParams.set("where", `Name=="${name}"`);
    url.searchParams.set("summaryOnly", "true");
    return { method: "GET", url: url.toString(), headers: tenantHeaders(context) };
  },
  upsertContact(context: Pick<ProviderContext, "tokens" | "tenantId" | "idempotencyKey">, contact: ContactInput): ProviderRequest {
    const body: Record<string, unknown> = {
      Name: contact.name.slice(0, 255),
      ContactNumber: xeroContactNumber(contact.localId),
    };
    if (contact.remoteId) body.ContactID = contact.remoteId;
    if (contact.email) body.EmailAddress = contact.email;
    if (contact.phone) body.Phones = [{ PhoneType: "MOBILE", PhoneNumber: contact.phone }];
    return { method: "POST", url: `${XERO_API}/Contacts`, headers: { ...tenantHeaders(context), "Idempotency-Key": context.idempotencyKey }, body: { Contacts: [body] } };
  },
  pushInvoice(context: ProviderContext, invoice: InvoiceInput): ProviderRequest {
    const accountCode = context.settings.salesAccountCode ?? XERO_DEFAULT_SALES_ACCOUNT;
    const hasTax = invoice.taxPence > 0;
    const lines: Record<string, unknown>[] = invoice.lines.map((line) => ({
      Description: line.description,
      Quantity: Number(line.quantity),
      UnitAmount: penceToNumber(line.unitPricePence),
      LineAmount: penceToNumber(line.lineTotalPence),
      AccountCode: accountCode,
      TaxType: hasTax ? "OUTPUT2" : "NONE",
      ...(hasTax ? { TaxAmount: penceToNumber(line.taxPence) } : {}),
    }));
    if (invoice.discountPence > 0) {
      lines.push({ Description: "Discount", Quantity: 1, UnitAmount: penceToNumber(-invoice.discountPence), LineAmount: penceToNumber(-invoice.discountPence), AccountCode: accountCode, TaxType: hasTax ? "OUTPUT2" : "NONE" });
    }
    return {
      method: "POST",
      url: `${XERO_API}/Invoices`,
      headers: { ...tenantHeaders(context), "Idempotency-Key": context.idempotencyKey },
      body: {
        Invoices: [
          {
            Type: "ACCREC",
            Contact: { ContactID: invoice.contactRemoteId },
            InvoiceNumber: invoice.number,
            ...(invoice.reference ? { Reference: invoice.reference } : {}),
            Date: invoice.issueDate,
            DueDate: invoice.dueDate,
            CurrencyCode: invoice.currency,
            LineAmountTypes: hasTax ? "Exclusive" : "NoTax",
            Status: "AUTHORISED",
            LineItems: lines,
          },
        ],
      },
    };
  },
  pushPayment(context: ProviderContext, payment: PaymentInput): ProviderRequest {
    return {
      method: "PUT",
      url: `${XERO_API}/Payments`,
      headers: { ...tenantHeaders(context), "Idempotency-Key": context.idempotencyKey },
      body: {
        Payments: [
          {
            Invoice: { InvoiceID: payment.invoiceRemoteId },
            Account: { Code: context.settings.bankAccountCode ?? XERO_DEFAULT_BANK_ACCOUNT },
            Date: payment.paidOn,
            Amount: penceToNumber(payment.amountPence),
            ...(payment.reference ? { Reference: payment.reference } : {}),
          },
        ],
      },
    };
  },
};

function tenantHeaders(context: Pick<ProviderContext, "tokens" | "tenantId">): Record<string, string> {
  return { Authorization: bearer(context.tokens.accessToken), "xero-tenant-id": context.tenantId };
}

export const xeroMappers = {
  tenants(body: unknown): AccountingTenant[] {
    return asArray(body)
      .map(asRecord)
      .filter((row) => row.tenantType === undefined || row.tenantType === "ORGANISATION")
      .map((row) => ({ id: requireString(row.tenantId, "tenantId"), name: typeof row.tenantName === "string" ? row.tenantName : "Xero organisation" }));
  },
  contactId(body: unknown): string | null {
    const first = asRecord(asArray(asRecord(body).Contacts)[0]);
    return typeof first.ContactID === "string" ? first.ContactID : null;
  },
  invoiceId(body: unknown): string {
    return requireString(asRecord(asArray(asRecord(body).Invoices)[0]).InvoiceID, "InvoiceID");
  },
  paymentId(body: unknown): string {
    return requireString(asRecord(asArray(asRecord(body).Payments)[0]).PaymentID, "PaymentID");
  },
  /** Xero's own error types on top of the HTTP mapping. */
  error(response: ProviderResponse, now?: Date): AccountingError | null {
    if (response.status >= 200 && response.status < 300) return null;
    const type = asRecord(response.body).Type;
    if (response.status === 400 && type === "ValidationException") return new AccountingError("VALIDATION", { status: 400, detail: "ValidationException" });
    try {
      ensureOk(response, now);
    } catch (error) {
      return error as AccountingError;
    }
    return null;
  },
};

function check(response: ProviderResponse, now: Date) {
  const error = xeroMappers.error(response, now);
  if (error) throw error;
  return response;
}

export function createXeroProvider(options: { env?: Readonly<Record<string, string | undefined>>; fetch?: FetchLike; now?: () => Date } = {}): AccountingProvider {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const clientId = env.XERO_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.XERO_CLIENT_SECRET?.trim() ?? "";
  const configured = clientId.length > 0 && clientSecret.length > 0;
  const credentials = { clientId, clientSecret };

  function requireConfigured() {
    if (!configured) throw new AccountingError("CONFIGURATION_REQUIRED", { detail: "XERO_CLIENT_ID/XERO_CLIENT_SECRET" });
  }

  async function token(request: ProviderRequest, tenantHint?: string | null): Promise<TokenSet> {
    requireConfigured();
    const at = now();
    const response = await send(fetcher, request);
    if (response.status < 200 || response.status >= 300) throw mapTokenError(response, at);
    return { ...mapTokenResponse(response.body, at, XERO_SCOPES), tenantHint: tenantHint ?? null };
  }

  return {
    id: "xero",
    name: "Xero",
    configured,
    scopes: XERO_SCOPES,
    authorizeUrl(input) {
      requireConfigured();
      return xeroRequests.authorizeUrl(credentials, input);
    },
    async exchangeCode(input) {
      return token(xeroRequests.exchange(credentials, input));
    },
    async refresh(tokens) {
      if (!tokens.refreshToken) throw new AccountingError("AUTH_EXPIRED", { detail: "no refresh token" });
      return token(xeroRequests.refresh(credentials, tokens.refreshToken));
    },
    async revoke(tokens) {
      requireConfigured();
      const response = await send(fetcher, xeroRequests.revoke(credentials, tokens.refreshToken ?? tokens.accessToken));
      check(response, now());
    },
    async listTenants(tokens) {
      const response = check(await send(fetcher, xeroRequests.connections(tokens.accessToken)), now());
      return xeroMappers.tenants(response.body);
    },
    async upsertContact(context, contact) {
      if (!contact.remoteId) {
        const found = check(await send(fetcher, xeroRequests.findContactByNumber(context, contact.localId)), now());
        const existing = xeroMappers.contactId(found.body);
        if (existing) return { remoteId: existing };
      }
      const response = await send(fetcher, xeroRequests.upsertContact(context, contact));
      const error = xeroMappers.error(response, now());
      if (error?.code === "VALIDATION" && !contact.remoteId) {
        // Names are unique in Xero: an existing customer of the same name is the same contact.
        const byName = xeroRequests.findContactByName(context, contact.name);
        if (byName) {
          const existing = xeroMappers.contactId(check(await send(fetcher, byName), now()).body);
          if (existing) return { remoteId: existing };
        }
      }
      if (error) throw error;
      const id = xeroMappers.contactId(response.body);
      if (!id) throw new AccountingError("UNEXPECTED_RESPONSE", { detail: "missing ContactID" });
      return { remoteId: id };
    },
    async pushInvoice(context, invoice) {
      const response = check(await send(fetcher, xeroRequests.pushInvoice(context, invoice)), now());
      return { remoteId: xeroMappers.invoiceId(response.body) };
    },
    async pushPayment(context, payment) {
      const response = check(await send(fetcher, xeroRequests.pushPayment(context, payment)), now());
      return { remoteId: xeroMappers.paymentId(response.body) };
    },
  };
}
