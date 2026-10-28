// Payments (P5.4): money, deposit rules, labels and totals. Pure and client-safe; the SQL function
// payment_deposit_amount() is the source of truth for deposits and a unit test keeps this in step.

export const PAYMENT_KINDS = ["deposit", "invoice", "no_show_fee"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_STATUSES = ["pending", "paid", "expired", "cancelled", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_ATTENTION = ["paid_after_release", "invoice_not_open", "overpaid", "amount_mismatch"] as const;
export type PaymentAttention = (typeof PAYMENT_ATTENTION)[number];

export const SERVICE_DEPOSIT_MODES = ["default", "none", "fixed", "percent"] as const;
export type ServiceDepositMode = (typeof SERVICE_DEPOSIT_MODES)[number];
export type DefaultDepositMode = Exclude<ServiceDepositMode, "default">;

export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  deposit: "Deposit",
  invoice: "Invoice",
  no_show_fee: "No-show fee",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "Waiting to be paid",
  paid: "Paid",
  expired: "Expired",
  cancelled: "Cancelled",
  failed: "Failed",
};

export const PAYMENT_ATTENTION_LABELS: Record<PaymentAttention, string> = {
  paid_after_release: "Paid after the slot was released: refund or rebook",
  invoice_not_open: "Paid after the invoice was settled or voided: refund it",
  overpaid: "Paid more than the balance: refund the difference",
  amount_mismatch: "Amount differs from what was asked: check it",
};

/** Limits shared with the database checks. */
export const MIN_PAYMENT_PENCE = 100;
export const MAX_DEPOSIT_PENCE = 100_000;
export const MAX_NO_SHOW_FEE_PENCE = 100_000;
export const MIN_HOLD_MIN = 30;
export const MAX_HOLD_MIN = 180;
export const DEFAULT_HOLD_MIN = 30;

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatPounds(pence: number | null | undefined): string {
  return typeof pence === "number" && Number.isFinite(pence) ? pounds.format(pence / 100) : "–";
}

/** "20", "20.5", "£20.00", "1,250" → pence; null for anything else (negative, more than 2 decimals, empty). */
export function parsePoundsToPence(input: string | null | undefined): number | null {
  const cleaned = (input ?? "").trim().replace(/^£/, "").replace(/,/g, "").trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export type DepositSettings = {
  depositsEnabled: boolean;
  defaultMode: DefaultDepositMode;
  defaultValue: number | null;
};

export type DepositService = {
  depositMode: ServiceDepositMode;
  depositValue: number | null;
  pricePence: number | null;
  priceMode: "fixed" | "from" | "quote";
};

/** Mirrors payment_deposit_amount(): the deposit in pence, or null for none. */
export function depositAmountPence(settings: DepositSettings | null, service: DepositService): number | null {
  if (!settings?.depositsEnabled) return null;
  const mode = service.depositMode === "default" ? settings.defaultMode : service.depositMode;
  const value = service.depositMode === "default" ? settings.defaultValue : service.depositValue;
  let amount: number | null = null;
  if (mode === "fixed") amount = value;
  else if (mode === "percent" && service.priceMode !== "quote" && (service.pricePence ?? 0) > 0 && value !== null) {
    amount = Math.round(((service.pricePence ?? 0) * value) / 100);
  }
  if (amount === null || amount < MIN_PAYMENT_PENCE) return null;
  return Math.min(amount, MAX_DEPOSIT_PENCE);
}

/** How a deposit rule reads in a list: "£20.00", "20% of the price", "Garage default", "No deposit". */
export function depositRuleLabel(mode: ServiceDepositMode, value: number | null): string {
  if (mode === "default") return "Garage default";
  if (mode === "none") return "No deposit";
  if (mode === "fixed") return formatPounds(value);
  return `${value ?? 0}% of the price`;
}

export type DepositRuleInput = { mode: string; amount?: string | null; percent?: string | null };

export type DepositRuleResult =
  | { ok: true; mode: ServiceDepositMode; value: number | null }
  | { ok: false; field: "amount" | "percent" | "mode"; message: string };

/** Validates a deposit rule from a form. `allowDefault` for services (they may follow the garage). */
export function parseDepositRule(input: DepositRuleInput, allowDefault: boolean): DepositRuleResult {
  const mode = input.mode as ServiceDepositMode;
  if (!SERVICE_DEPOSIT_MODES.includes(mode) || (!allowDefault && mode === "default")) {
    return { ok: false, field: "mode", message: "Choose how much deposit to take." };
  }
  if (mode === "default" || mode === "none") return { ok: true, mode, value: null };
  if (mode === "fixed") {
    const pence = parsePoundsToPence(input.amount);
    if (pence === null || pence < MIN_PAYMENT_PENCE || pence > MAX_DEPOSIT_PENCE) {
      return { ok: false, field: "amount", message: "Enter an amount from £1 to £1,000, for example 20 or 25.50." };
    }
    return { ok: true, mode, value: pence };
  }
  const percent = Number((input.percent ?? "").trim());
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    return { ok: false, field: "percent", message: "Enter a whole percentage from 1 to 100." };
  }
  return { ok: true, mode, value: percent };
}

export type PaymentRowForTotals = { status: PaymentStatus; kind: PaymentKind; amountPence: number; amountPaidPence: number | null; paidAt: string | null; attention: string | null };

export type PaymentTotals = {
  paidThisMonthPence: number;
  paidThisMonthCount: number;
  waitingPence: number;
  waitingCount: number;
  depositsHeldPence: number;
  attentionCount: number;
};

/** Totals for /app/payments. `monthStart` is the first instant of the garage-local month. */
export function paymentTotals(rows: readonly PaymentRowForTotals[], monthStart: Date): PaymentTotals {
  const totals: PaymentTotals = { paidThisMonthPence: 0, paidThisMonthCount: 0, waitingPence: 0, waitingCount: 0, depositsHeldPence: 0, attentionCount: 0 };
  for (const row of rows) {
    if (row.status === "paid" && row.paidAt && Date.parse(row.paidAt) >= monthStart.getTime()) {
      totals.paidThisMonthPence += row.amountPaidPence ?? row.amountPence;
      totals.paidThisMonthCount += 1;
    }
    if (row.status === "pending") {
      totals.waitingPence += row.amountPence;
      totals.waitingCount += 1;
    }
    if (row.status === "paid" && row.kind === "deposit" && !row.attention) totals.depositsHeldPence += row.amountPaidPence ?? row.amountPence;
    if (row.status === "paid" && row.attention) totals.attentionCount += 1;
  }
  return totals;
}

export function isPaymentKind(value: unknown): value is PaymentKind {
  return typeof value === "string" && (PAYMENT_KINDS as readonly string[]).includes(value);
}

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}
