// Accounting sync contract (P5.10, D17). Client-safe types only: no secrets, no I/O.
//
// Every provider (Xero, QuickBooks Online, Sage Business Cloud Accounting and the fake) implements
// AccountingProvider. Amounts are integer pence in our model; adapters convert to the provider's
// decimal strings/numbers. Provider errors are mapped to AccountingError codes, never passed on as
// provider text (it can carry customer names), so a code is all that reaches logs and the database.

export const ACCOUNTING_PROVIDERS = ["xero", "quickbooks", "sage", "fake"] as const;
export type AccountingProviderId = (typeof ACCOUNTING_PROVIDERS)[number];
/** The providers a garage can choose on the settings page. */
export const REAL_ACCOUNTING_PROVIDERS = ["xero", "quickbooks", "sage"] as const satisfies readonly AccountingProviderId[];

export const ACCOUNTING_PROVIDER_NAMES: Record<AccountingProviderId, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
  sage: "Sage Accounting",
  fake: "Test accounts (fake)",
};

export function isAccountingProviderId(value: unknown): value is AccountingProviderId {
  return typeof value === "string" && (ACCOUNTING_PROVIDERS as readonly string[]).includes(value);
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working. */
  expiresAt: Date;
  /** When the refresh token stops working, if the provider says. */
  refreshExpiresAt: Date | null;
  scopes: string[];
  /** QuickBooks: the company (realmId) chosen during consent, from the callback URL. */
  tenantHint?: string | null;
};

export type AccountingTenant = { id: string; name: string };

/** Per-connection mapping (accounting_connections.settings). Optional: adapters have defaults or look them up. */
export type AccountingSettings = {
  /** Xero sales account code (default 200, "Sales" in the UK chart of accounts). */
  salesAccountCode?: string;
  /** Xero bank account code payments go to (default 090, "Business Bank Account"). */
  bankAccountCode?: string;
  /** QuickBooks item the invoice lines use (default 1, "Services"). */
  itemId?: string;
  /** QuickBooks tax code id for lines (left out when unset: the company's default). */
  taxCodeId?: string;
  /** Sage ledger account id for sales (looked up when unset). */
  ledgerAccountId?: string;
  /** Sage bank account id for receipts (looked up when unset). */
  bankAccountId?: string;
};

export type ProviderContext = {
  tokens: TokenSet;
  tenantId: string;
  settings: AccountingSettings;
  /** Stable per item: the provider de-duplicates retries where it supports it. */
  idempotencyKey: string;
};

export type ContactInput = {
  /** Our stable key for the contact (customer id, or the invoice id for a walk-in). */
  localId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Remote id from an earlier sync, to update instead of create. */
  remoteId?: string | null;
};

export type InvoiceLineInput = {
  description: string;
  /** Up to 3 decimal places, as stored. */
  quantity: string;
  unitPricePence: number;
  lineTotalPence: number;
  /** VAT on the line in pence. Autofix invoices carry no VAT yet (VAT_NOT_CONFIGURED), so 0. */
  taxPence: number;
};

export type InvoiceInput = {
  localId: string;
  contactRemoteId: string;
  number: string;
  /** Free text reference (booking reference or vehicle). Never a registration (rule 3). */
  reference: string | null;
  issueDate: string;
  dueDate: string;
  currency: "GBP";
  lines: InvoiceLineInput[];
  discountPence: number;
  taxPence: number;
  totalPence: number;
};

export type PaymentInput = {
  localId: string;
  invoiceRemoteId: string;
  contactRemoteId: string;
  amountPence: number;
  /** yyyy-mm-dd in the garage's time zone. */
  paidOn: string;
  reference: string | null;
  method: "cash" | "card" | "bank_transfer" | "other";
};

export type AuthorizeInput = { state: string; codeChallenge: string; redirectUri: string };
export type ExchangeInput = { code: string; codeVerifier: string; redirectUri: string; callbackParams: URLSearchParams };

export interface AccountingProvider {
  readonly id: AccountingProviderId;
  readonly name: string;
  /** False when the client id/secret are missing: the settings page says "configuration required". */
  readonly configured: boolean;
  /** Scopes asked for at consent. */
  readonly scopes: readonly string[];
  authorizeUrl(input: AuthorizeInput): string;
  exchangeCode(input: ExchangeInput): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  /** Best effort: revoke the refresh (or access) token at the provider. */
  revoke(tokens: TokenSet): Promise<void>;
  listTenants(tokens: TokenSet): Promise<AccountingTenant[]>;
  upsertContact(context: ProviderContext, contact: ContactInput): Promise<{ remoteId: string }>;
  pushInvoice(context: ProviderContext, invoice: InvoiceInput): Promise<{ remoteId: string }>;
  pushPayment(context: ProviderContext, payment: PaymentInput): Promise<{ remoteId: string }>;
}

export const ACCOUNTING_ERROR_CODES = [
  "RATE_LIMITED",
  "AUTH_EXPIRED",
  "VALIDATION",
  "NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "NETWORK",
  "CONFIGURATION_REQUIRED",
  "UNEXPECTED_RESPONSE",
] as const;
export type AccountingErrorCode = (typeof ACCOUNTING_ERROR_CODES)[number];

/** A provider failure as a typed code. `message` is ours (safe to log), never the provider's text. */
export class AccountingError extends Error {
  readonly code: AccountingErrorCode;
  /** Seconds to wait (RATE_LIMITED, from Retry-After). */
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;

  constructor(code: AccountingErrorCode, options: { status?: number | null; retryAfterSeconds?: number | null; detail?: string } = {}) {
    super(options.detail ? `${code}: ${options.detail}` : code);
    this.name = "AccountingError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  /** Worth another attempt later (the item stays pending with backoff). */
  get retryable() {
    return this.code === "RATE_LIMITED" || this.code === "PROVIDER_UNAVAILABLE" || this.code === "NETWORK" || this.code === "UNEXPECTED_RESPONSE";
  }
}

export function isAccountingError(error: unknown): error is AccountingError {
  return error instanceof AccountingError;
}

/** Retry-After as seconds (delta seconds or an HTTP date); null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 24 * 3600);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(Math.ceil((at - now.getTime()) / 1000), 24 * 3600));
}

/** Pence as a decimal string with 2 places (`12345` → `"123.45"`). */
export function penceToDecimal(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(Math.trunc(pence));
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** Pence as a number of pounds (`12345` → `123.45`), for providers that take JSON numbers. */
export function penceToNumber(pence: number): number {
  return Number(penceToDecimal(pence));
}
