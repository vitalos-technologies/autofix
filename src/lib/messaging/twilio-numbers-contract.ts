// Twilio phone numbers contract (D22): the client interface, its types and its errors. Pure, so the
// live client (twilio-numbers.ts) and the mock (twilio-numbers-mock.ts) share it without importing each
// other. The Twilio docs this is built from, and the date they were read, are listed in twilio-numbers.ts.

export type TwilioNumbersMode = "mock" | "live";
export type NumberKind = "mobile" | "local";

export type TwilioAccount = {
  /** `Trial` or `Full` (upgraded). */
  type: string;
  /** `active`, `suspended` or `closed`. */
  status: string;
};

/** A number the account holds (IncomingPhoneNumber). */
export type OwnedNumber = { sid: string; phoneNumber: string; friendlyName: string; sms: boolean; voice: boolean };

/** A number in the Messaging Service's sender pool. */
export type ServiceNumber = { sid: string; phoneNumber: string; capabilities: string[] };

export type AvailableNumber = { phoneNumber: string; sms: boolean; voice: boolean; addressRequirements: string };

export type BuyNumberInput = {
  phoneNumber: string;
  /** Up to 64 characters; names what the number is for, so a later run can find it. */
  friendlyName: string;
  /** Voice and call status webhook (`…/api/webhooks/twilio/voice`). */
  voiceUrl: string;
  bundleSid: string;
  addressSid?: string | null;
};

export type SearchOptions = {
  /** Twilio `Contains` pattern, e.g. `+441302` (the start of the number). */
  contains?: string;
  /** Only numbers that can text. */
  sms?: boolean;
  limit?: number;
};

/** Everything the provisioning step needs from Twilio. `createTwilioNumbersClient` is the live one. */
export interface TwilioNumbersClient {
  readonly mode: TwilioNumbersMode;
  getAccount(): Promise<TwilioAccount>;
  /** Every number the account holds (all pages, up to 5 000). */
  listNumbers(): Promise<OwnedNumber[]>;
  /** The numbers in the configured Messaging Service. */
  listServiceNumbers(): Promise<ServiceNumber[]>;
  /** The SID of an approved GB bundle for the number type (and end-user type), or null. */
  findApprovedBundle(kind: NumberKind, endUserType?: "business"): Promise<string | null>;
  /** The SID of a GB address on the account, or null. */
  findAddress(): Promise<string | null>;
  /** Available GB numbers with voice (and SMS when asked). */
  searchAvailable(kind: NumberKind, options?: SearchOptions): Promise<AvailableNumber[]>;
  /** Buys a number. Never retried: an ambiguous failure throws `timeout`. */
  buyNumber(input: BuyNumberInput): Promise<OwnedNumber>;
  /** Adds a number the account holds to the Messaging Service. */
  addToService(numberSid: string): Promise<void>;
}

export type TwilioNumbersErrorKind =
  | "configuration_required"
  | "trial_account"
  | "bundle_required"
  | "address_required"
  | "number_unavailable"
  | "rate_limited"
  | "provider_error"
  | "timeout"
  | "refused";

/** A Twilio failure with a safe kind and code (no URLs, numbers, credentials or provider text). */
export class TwilioNumbersError extends Error {
  readonly kind: TwilioNumbersErrorKind;
  readonly providerCode: number | null;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;

  constructor(kind: TwilioNumbersErrorKind, message: string, meta: { providerCode?: number | null; httpStatus?: number | null; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = "TwilioNumbersError";
    this.kind = kind;
    this.providerCode = meta.providerCode ?? null;
    this.httpStatus = meta.httpStatus ?? null;
    this.retryAfterMs = meta.retryAfterMs ?? null;
  }

  /** `twilio:<code>` (or `http:<status>`, or the kind), safe for logs and the state's reason column. */
  get reason(): string {
    if (this.providerCode !== null) return `twilio:${this.providerCode}`;
    if (this.httpStatus !== null) return `http:${this.httpStatus}`;
    return this.kind;
  }
}

export function isTwilioNumbersError(error: unknown): error is TwilioNumbersError {
  return error instanceof TwilioNumbersError;
}

const KIND_BY_CODE: Record<number, TwilioNumbersErrorKind> = {
  21404: "trial_account",
  21649: "bundle_required",
  21631: "address_required",
  21615: "address_required",
  21422: "number_unavailable",
  20429: "rate_limited",
  20003: "configuration_required",
  20404: "configuration_required",
};

function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Maps an HTTP status and Twilio `code` to an error kind. */
export function mapTwilioNumbersError(operation: string, httpStatus: number, code: number | null, retryAfter?: string | null): TwilioNumbersError {
  const meta = { providerCode: code, httpStatus, retryAfterMs: retryAfterMs(retryAfter) };
  const byCode = code !== null ? KIND_BY_CODE[code] : undefined;
  const kind: TwilioNumbersErrorKind = byCode
    ?? (httpStatus === 429 ? "rate_limited"
      : httpStatus === 401 || httpStatus === 403 ? "configuration_required"
        : httpStatus >= 500 ? "provider_error"
          : "refused");
  return new TwilioNumbersError(kind, `Twilio ${operation}: HTTP ${httpStatus}${code !== null ? ` ${code}` : ""}`, meta);
}
