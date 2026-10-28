// Fleet and trade accounts (P5.7, Pro feature `fleet_accounts`): the pure, client-safe part.
// Form parsing for an account, labels, statement periods, the statement CSV and the
// plain-English messages for the database's error codes. Server reads are in ./queries.ts.

import { toE164UK } from "@/lib/messaging/phone";
import { MAX_PRICE_PENCE, parsePounds, penceToPoundsInput } from "@/lib/settings/setup";

export const ACCOUNT_KINDS = ["fleet", "trade"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = { fleet: "Fleet", trade: "Trade" };

export const ACCOUNT_BILLING = ["monthly", "per_invoice"] as const;
export type AccountBilling = (typeof ACCOUNT_BILLING)[number];
export const BILLING_LABELS: Record<AccountBilling, string> = { monthly: "Monthly statement", per_invoice: "Invoice each job" };
export const BILLING_HINTS: Record<AccountBilling, string> = {
  monthly: "Invoices are charged to the account and go on one statement a month. They are not emailed one by one.",
  per_invoice: "Each invoice is emailed when it is issued. You can still make a statement when they ask for one.",
};

export const STATEMENT_STATUSES = ["draft", "issued", "paid"] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];
export const STATEMENT_STATUS_LABELS: Record<StatementStatus, string> = { draft: "Draft", issued: "Issued", paid: "Paid" };

export const PERSON_ROLES = ["driver", "contact"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];
export const PERSON_ROLE_LABELS: Record<PersonRole, string> = { driver: "Driver", contact: "Contact" };

export const PAYMENT_TERMS_MAX = 120;
export const PO_MAX = 40;

/** The account's columns as staff write them (RLS client; the garage comes from the selected garage). */
export type AccountValues = {
  name: string;
  kind: AccountKind;
  company_number: string | null;
  billing_email: string | null;
  billing_address: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  payment_terms_days: number;
  po_required: boolean;
  discount_percent: number | null;
  credit_limit_pence: number | null;
  billing: AccountBilling;
  notes: string | null;
};

export type AccountField =
  | "name"
  | "kind"
  | "companyNumber"
  | "billingEmail"
  | "billingAddress"
  | "contactName"
  | "contactPhone"
  | "contactEmail"
  | "paymentTermsDays"
  | "discountPercent"
  | "creditLimit"
  | "billing"
  | "notes";

export const ACCOUNT_FIELD_ORDER: AccountField[] = [
  "name",
  "kind",
  "companyNumber",
  "billingEmail",
  "billingAddress",
  "contactName",
  "contactPhone",
  "contactEmail",
  "billing",
  "paymentTermsDays",
  "discountPercent",
  "creditLimit",
  "notes",
];

/** The form's values, as strings, for editing an account. */
export type AccountFormValues = Record<Exclude<AccountField, "kind" | "billing">, string> & {
  kind: AccountKind;
  billing: AccountBilling;
  poRequired: boolean;
};

export const EMPTY_ACCOUNT_FORM: AccountFormValues = {
  name: "",
  kind: "fleet",
  companyNumber: "",
  billingEmail: "",
  billingAddress: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  billing: "monthly",
  paymentTermsDays: "30",
  poRequired: false,
  discountPercent: "",
  creditLimit: "",
  notes: "",
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** UK company numbers are 8 characters: `1234567` → `01234567`, `sc 123456` → `SC123456`. Null when it can't be one. */
export function normaliseCompanyNumber(input: string): string | null {
  const compact = input.replace(/\s+/g, "").toUpperCase();
  if (!compact) return null;
  const padded = /^\d{1,8}$/.test(compact) ? compact.padStart(8, "0") : compact;
  return /^[A-Z0-9]{8}$/.test(padded) ? padded : null;
}

type FormSource = Pick<FormData, "get">;

function read(form: FormSource, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export type ParsedAccount = { ok: true; value: AccountValues } | { ok: false; fieldErrors: Partial<Record<AccountField, string>> };

/** Checks the account form (also run again by the server action). */
export function parseAccountForm(form: FormSource): ParsedAccount {
  const errors: Partial<Record<AccountField, string>> = {};
  const name = read(form, "name").replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) errors.name = "Enter the business name (2 to 120 characters).";

  const kindInput = read(form, "kind");
  const kind = (ACCOUNT_KINDS as readonly string[]).includes(kindInput) ? (kindInput as AccountKind) : null;
  if (!kind) errors.kind = "Choose fleet or trade.";

  const companyInput = read(form, "companyNumber");
  const companyNumber = companyInput ? normaliseCompanyNumber(companyInput) : null;
  if (companyInput && !companyNumber) errors.companyNumber = "A UK company number is 8 letters and digits, like 01234567 or SC123456.";

  const billingEmail = read(form, "billingEmail").toLowerCase();
  if (billingEmail && (!EMAIL.test(billingEmail) || billingEmail.length > 254)) errors.billingEmail = "Enter a valid email address.";

  const billingAddress = read(form, "billingAddress").replace(/\r\n/g, "\n");
  if (billingAddress.length > 500) errors.billingAddress = "Keep the address under 500 characters.";

  const contactName = read(form, "contactName");
  if (contactName.length > 120) errors.contactName = "Keep the name under 120 characters.";

  const phoneInput = read(form, "contactPhone");
  const contactPhone = phoneInput ? toE164UK(phoneInput, { allowLandline: true }) : null;
  if (phoneInput && !contactPhone) errors.contactPhone = "Enter a UK mobile or landline number.";

  const contactEmail = read(form, "contactEmail").toLowerCase();
  if (contactEmail && (!EMAIL.test(contactEmail) || contactEmail.length > 254)) errors.contactEmail = "Enter a valid email address.";

  const billingInput = read(form, "billing");
  const billing = (ACCOUNT_BILLING as readonly string[]).includes(billingInput) ? (billingInput as AccountBilling) : null;
  if (!billing) errors.billing = "Choose how this account is billed.";
  if (billing === "monthly" && !billingEmail) errors.billingEmail = "Monthly statements are emailed: enter the accounts email.";

  const termsInput = read(form, "paymentTermsDays");
  const terms = /^\d{1,3}$/.test(termsInput) ? Number.parseInt(termsInput, 10) : Number.NaN;
  if (!Number.isInteger(terms) || terms < 0 || terms > PAYMENT_TERMS_MAX) errors.paymentTermsDays = `Enter 0 to ${PAYMENT_TERMS_MAX} days.`;

  const discountInput = read(form, "discountPercent").replace(/%$/, "").trim();
  let discount: number | null = null;
  if (discountInput) {
    discount = /^\d{1,3}(\.\d{1,2})?$/.test(discountInput) ? Number(discountInput) : Number.NaN;
    if (!Number.isFinite(discount) || discount <= 0 || discount > 100) errors.discountPercent = "Enter a discount between 0.01 and 100, or leave it empty.";
  }

  const creditInput = read(form, "creditLimit");
  let creditLimit: number | null = null;
  if (creditInput) {
    creditLimit = parsePounds(creditInput);
    if (creditLimit === null || creditLimit > MAX_PRICE_PENCE) errors.creditLimit = "Enter an amount in pounds, like 2500, or leave it empty.";
  }

  const notes = read(form, "notes");
  if (notes.length > 2000) errors.notes = "Keep notes under 2,000 characters.";

  if (Object.keys(errors).length || !kind || !billing) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      name,
      kind,
      company_number: companyNumber,
      billing_email: billingEmail || null,
      billing_address: billingAddress || null,
      contact_name: contactName || null,
      contact_phone: contactPhone,
      contact_email: contactEmail || null,
      payment_terms_days: terms,
      po_required: form.get("poRequired") === "on",
      discount_percent: discount,
      credit_limit_pence: creditLimit,
      billing,
      notes: notes || null,
    },
  };
}

/** An account row as the form edits it. */
export function accountFormValues(row: AccountValues): AccountFormValues {
  return {
    name: row.name,
    kind: row.kind,
    companyNumber: row.company_number ?? "",
    billingEmail: row.billing_email ?? "",
    billingAddress: row.billing_address ?? "",
    contactName: row.contact_name ?? "",
    contactPhone: row.contact_phone ?? "",
    contactEmail: row.contact_email ?? "",
    billing: row.billing,
    paymentTermsDays: String(row.payment_terms_days),
    poRequired: row.po_required,
    discountPercent: row.discount_percent === null ? "" : String(Number(row.discount_percent)),
    creditLimit: row.credit_limit_pence === null ? "" : penceToPoundsInput(Number(row.credit_limit_pence)),
    notes: row.notes ?? "",
  };
}

/** The PO number as stored: trimmed, at most 40 characters, null when empty. */
export function cleanPoNumber(input: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return { ok: true, value: null };
  if (value.length > PO_MAX) return { ok: false, message: `A PO number is at most ${PO_MAX} characters.` };
  return { ok: true, value };
}

/**
 * The payment terms and notes a draft invoice gets when its booking is charged to an account: the
 * bill-to is the account (shown on the invoice from its link), the driver stays the invoice's customer.
 */
export function accountInvoiceTerms(account: { name: string; billing: AccountBilling; paymentTermsDays: number; poNumber: string | null; discountPercent: number | null }): { paymentTerms: string; notes: string } {
  const paymentTerms = account.billing === "monthly"
    ? `Charged to ${account.name}'s account. Payable on the monthly statement within ${account.paymentTermsDays} days of issue.`
    : `Charged to ${account.name}'s account. Payment due within ${account.paymentTermsDays} days.`;
  const notes = [account.poNumber ? `PO ${account.poNumber}` : null, account.discountPercent ? `Account discount ${account.discountPercent}%` : null].filter(Boolean).join(". ");
  return { paymentTerms, notes };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

function zonedYearMonth(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(at);
  return { year: Number(parts.find((part) => part.type === "year")?.value), month: Number(parts.find((part) => part.type === "month")?.value) };
}

/** The first day (YYYY-MM-DD) of the month before `at`'s month in the garage's time zone: the month a statement made on the 1st covers. */
export function previousStatementMonth(at: Date, timeZone = "Europe/London"): string {
  const { year, month } = zonedYearMonth(at, timeZone);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, "0")}-01`;
}

/** The first day of `at`'s month in the garage's time zone. */
export function currentStatementMonth(at: Date, timeZone = "Europe/London"): string {
  const { year, month } = zonedYearMonth(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** The last `count` month starts, newest first, ending with `at`'s month. */
export function recentStatementMonths(at: Date, timeZone = "Europe/London", count = 6): string[] {
  const { year, month } = zonedYearMonth(at, timeZone);
  return Array.from({ length: count }, (_, index) => {
    const total = year * 12 + (month - 1) - index;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
  });
}

export function isMonthStart(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value);
}

/** `2026-09-01` → `September 2026`. */
export function periodLabel(monthStart: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${monthStart}T12:00:00Z`));
}

/** `2026-09-30` → `30 September 2026`. */
export function longDate(dateKey: string | null): string {
  if (!dateKey) return "Not set";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${dateKey.slice(0, 10)}T12:00:00Z`));
}

// ---------------------------------------------------------------------------
// Money and statements
// ---------------------------------------------------------------------------

/** £1,234.50 from pence. */
export function formatPounds(pence: number | string | bigint | null | undefined): string {
  const value = BigInt(pence ?? 0);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}£${String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${String(absolute % 100n).padStart(2, "0")}`;
}

export type StatementLine = {
  invoiceId: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  status: "issued" | "paid" | "void" | "draft";
  registration: string | null;
  driver: string;
  serviceName: string | null;
  poNumber: string | null;
  totalPence: number;
  paidPence: number;
};

export function lineBalance(line: Pick<StatementLine, "status" | "totalPence" | "paidPence">): number {
  if (line.status === "paid" || line.status === "void") return 0;
  return Math.max(0, line.totalPence - line.paidPence);
}

export function statementTotals(lines: readonly StatementLine[]) {
  const counted = lines.filter((line) => line.status === "issued" || line.status === "paid");
  const total = counted.reduce((sum, line) => sum + line.totalPence, 0);
  const balance = counted.reduce((sum, line) => sum + lineBalance(line), 0);
  return { total, paid: total - balance, balance, count: counted.length };
}

/** Where an account stands against its credit limit (null when it has none). */
export function creditPosition(limitPence: number | null, owedPence: number): { over: boolean; left: number } | null {
  if (limitPence === null || limitPence === undefined) return null;
  return { over: owedPence > limitPence, left: limitPence - owedPence };
}

function spreadsheetSafe(value: string) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${spreadsheetSafe(text).replaceAll('"', '""')}"`;
}

function poundsCell(pence: number) {
  const sign = pence < 0 ? "-" : "";
  const absolute = Math.abs(pence);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/** The statement as CSV (one row per invoice, then a total row). Spreadsheet formulas are neutralised. */
export function statementCsv(statement: { reference: string; accountName: string; periodStart: string }, lines: readonly StatementLine[]): string {
  const header = ["Statement", "Account", "Period", "Invoice", "Issue date", "Registration", "Driver", "Service", "PO number", "Status", "Total", "Paid", "Balance"];
  const period = periodLabel(statement.periodStart);
  const rows = lines.map((line) => [
    statement.reference,
    statement.accountName,
    period,
    line.invoiceNumber ?? "Draft",
    line.issueDate ?? "",
    line.registration ?? "",
    line.driver,
    line.serviceName ?? "",
    line.poNumber ?? "",
    line.status === "paid" ? "Paid" : line.status === "void" ? "Void" : "Unpaid",
    poundsCell(line.totalPence),
    poundsCell(line.totalPence - lineBalance(line)),
    poundsCell(lineBalance(line)),
  ]);
  const totals = statementTotals(lines);
  rows.push([statement.reference, statement.accountName, period, "Total", "", "", "", "", "", "", poundsCell(totals.total), poundsCell(totals.paid), poundsCell(totals.balance)]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** `Statement-HRM-ST-202609-001.csv`. */
export function statementFileName(reference: string, extension: "csv" | "pdf"): string {
  return `Statement-${reference.replace(/[^A-Za-z0-9-]/g, "") || "draft"}.${extension}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  PLAN_REQUIRED: "Fleet and trade accounts are on Pro. Upgrade in Settings, Plan to change them.",
  ACCOUNT_FORBIDDEN: "Only the garage's owners and managers can change business accounts.",
  ACCOUNT_NOT_FOUND: "That account could not be found. It may have been archived.",
  BOOKING_NOT_FOUND: "That booking could not be found.",
  PO_REQUIRED: "This account needs a purchase order (PO) number on every booking.",
  INVALID_PO_NUMBER: `A PO number is at most ${PO_MAX} characters.`,
  VEHICLE_ON_OTHER_ACCOUNT: "That car is already on another business account. Remove it there first.",
  INVALID_REGISTRATION: "Enter the car's registration, like AB12 CDE.",
  NOTHING_TO_BILL: "There are no issued invoices for this account to put on a statement for that month.",
  INVALID_PERIOD: "Choose a month for the statement.",
  STATEMENT_NOT_FOUND: "That statement could not be found.",
  STATEMENT_NOT_DRAFT: "That statement has already been issued.",
  STATEMENT_NOT_ISSUED: "Issue the statement first.",
  INVALID_PAYMENT_METHOD: "Choose how it was paid.",
  PAYMENT_DATE_REQUIRED: "Enter the date it was paid.",
  INVOICE_EMAIL_SEND_IN_PROGRESS: "An invoice on this statement is being emailed. Try again in a minute.",
  UNAUTHORISED: "Sign in again with two-step verification to make this change.",
};

/** A plain-English message for a database error from the account functions (never the database's own text). */
export function accountErrorMessage(error: { code?: string | null; message?: string | null } | null | undefined, fallback = "That could not be saved. Try again."): string {
  const message = error?.message ?? "";
  const code = Object.keys(ERROR_MESSAGES).find((key) => message.startsWith(key));
  if (code) return ERROR_MESSAGES[code]!;
  if (error?.code === "23505") return "There is already an active account with that name.";
  if (error?.code === "42501") return "You don't have permission to change this. Owners and managers can.";
  return fallback;
}
