// Customer service plans (P5.11): client-safe types, labels, form parsing, flash messages and the
// plan-year rule (mirrors public.service_plan_year_start(); a unit test compares the clock-change days).

export const SUBSCRIPTION_STATUSES = ["pending_mandate", "active", "past_due", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  pending_mandate: "Setting up",
  active: "Active",
  past_due: "Payment failed",
  cancelled: "Cancelled",
};

export const SUBSCRIPTION_STATUS_TONES: Record<SubscriptionStatus, "success" | "warning" | "info" | "muted"> = {
  pending_mandate: "info",
  active: "success",
  past_due: "warning",
  cancelled: "muted",
};

export const MAX_INCLUSIONS = 5;
export const MAX_PLAN_NAME = 60;
export const MAX_PLAN_DESCRIPTION = 500;
export const MAX_DISCOUNT_PERCENT = 50;

export type PlanInclusion = { serviceId: string; serviceName: string; usesPerYear: number };

export type ServicePlan = {
  id: string;
  name: string;
  description: string | null;
  pricePence: number;
  discountPercent: number;
  priorityBooking: boolean;
  status: "active" | "archived";
  inclusions: PlanInclusion[];
};

export type PlanSubscription = {
  id: string;
  planId: string;
  planName: string;
  status: SubscriptionStatus;
  pricePence: number;
  provider: "mock" | "stripe";
  customerId: string;
  customerName: string | null;
  vehicleId: string;
  registration: string | null;
  vehicleName: string | null;
  startedAt: string | null;
  renewsAt: string | null;
  lastPaymentFailedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lastNoticeKind: "confirmation" | "payment_failed" | null;
  lastNoticeChannel: string | null;
  lastNoticeOutcome: string | null;
  createdAt: string;
};

/** £19.99 */
export function formatPlanPrice(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** "£19.99 a month" */
export function monthlyPrice(pence: number): string {
  return `${formatPlanPrice(pence)} a month`;
}

/** What a plan gives, one line each, as a customer would read it. */
export function planBenefitLines(plan: Pick<ServicePlan, "inclusions" | "discountPercent" | "priorityBooking">): string[] {
  const lines = plan.inclusions.map((inclusion) =>
    inclusion.usesPerYear === 1 ? `${inclusion.serviceName} included once a year` : `${inclusion.serviceName} included ${inclusion.usesPerYear} times a year`);
  if (plan.discountPercent > 0) lines.push(`${plan.discountPercent}% off parts and labour`);
  if (plan.priorityBooking) lines.push("Priority booking: call us and we fit you in first");
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Plan year (A377): from started_at, whole years on the garage's local calendar.

function localParts(at: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** The instant of a local wall-clock time in `timeZone` (the earlier one when the clocks go back). */
function fromLocal(local: { year: number; month: number; day: number; hour: number; minute: number; second: number }, timeZone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  let at = guess;
  for (let i = 0; i < 3; i += 1) {
    const seen = localParts(new Date(at), timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    at += guess - seenUtc;
  }
  return new Date(at);
}

/** Start of the plan year `at` falls in (before `startedAt`: year one). Mirrors service_plan_year_start(). */
export function planYearStart(startedAt: Date, at: Date, timeZone = "Europe/London"): Date {
  const start = localParts(startedAt, timeZone);
  const now = localParts(at, timeZone);
  let years = now.year - start.year;
  // Not yet at this year's anniversary (local month, day and time): one year fewer.
  const a = [now.month, now.day, now.hour, now.minute, now.second];
  const b = [start.month, start.day, start.hour, start.minute, start.second];
  const index = a.findIndex((value, i) => value !== b[i]);
  if (index >= 0 && a[index]! < b[index]!) years -= 1;
  years = Math.max(0, years);
  // 29 February in a year without one becomes 28 February, as Postgres does.
  const year = start.year + years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = start.month === 2 && start.day === 29 && !leap ? 28 : start.day;
  return fromLocal({ ...start, year, day }, timeZone);
}

// ---------------------------------------------------------------------------------------------
// The plan form (owners and managers)

export type PlanFormValue = {
  name: string;
  description: string | null;
  pricePence: number;
  discountPercent: number;
  priorityBooking: boolean;
  inclusions: { serviceId: string; usesPerYear: number }[];
};

export type PlanFormResult = { ok: true; value: PlanFormValue } | { ok: false; field: "name" | "price" | "discount" | "inclusions" | "description"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Pounds as typed ("19.99", "£20") to pence, or null. */
export function poundsToPence(value: string): number | null {
  const cleaned = value.replace(/[£,\s]/g, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Reads the plan form: name, description, price (pounds), discount (%), priority booking, and for
 * each offered service `include_<serviceId>` = "on" with `uses_<serviceId>` = 1..12.
 */
export function parsePlanForm(formData: FormData, serviceIds: readonly string[]): PlanFormResult {
  const name = text(formData.get("name")).replace(/\s+/g, " ");
  if (name.length < 2 || name.length > MAX_PLAN_NAME) return { ok: false, field: "name", message: "Give the plan a name of 2 to 60 characters." };
  const description = text(formData.get("description")) || null;
  if (description && description.length > MAX_PLAN_DESCRIPTION) return { ok: false, field: "description", message: "Keep the description under 500 characters." };
  const pricePence = poundsToPence(text(formData.get("price")));
  if (pricePence === null || pricePence < 100 || pricePence > 100000) return { ok: false, field: "price", message: "Enter a monthly price from £1 to £1,000." };
  const rawDiscount = text(formData.get("discount")) || "0";
  const discountPercent = /^\d{1,2}$/.test(rawDiscount) ? Number(rawDiscount) : NaN;
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > MAX_DISCOUNT_PERCENT) {
    return { ok: false, field: "discount", message: "Enter a discount from 0 to 50%." };
  }
  const priorityBooking = formData.get("priority") === "on";
  const inclusions: PlanFormValue["inclusions"] = [];
  for (const serviceId of serviceIds) {
    if (!UUID.test(serviceId) || formData.get(`include_${serviceId}`) !== "on") continue;
    const uses = Number(text(formData.get(`uses_${serviceId}`)) || "1");
    if (!Number.isInteger(uses) || uses < 1 || uses > 12) return { ok: false, field: "inclusions", message: "Each included service can be used 1 to 12 times a year." };
    inclusions.push({ serviceId, usesPerYear: uses });
  }
  if (inclusions.length > MAX_INCLUSIONS) return { ok: false, field: "inclusions", message: "Include at most 5 services in one plan." };
  if (inclusions.length === 0 && discountPercent === 0 && !priorityBooking) {
    return { ok: false, field: "inclusions", message: "Include at least one service, a discount or priority booking." };
  }
  return { ok: true, value: { name, description, pricePence, discountPercent, priorityBooking, inclusions } };
}

/** The payload save_service_plan() takes. */
export function planPayload(value: PlanFormValue) {
  return {
    name: value.name,
    description: value.description,
    price_pence: value.pricePence,
    discount_percent: value.discountPercent,
    priority_booking: value.priorityBooking,
    inclusions: value.inclusions.map((inclusion) => ({ service_id: inclusion.serviceId, uses_per_year: inclusion.usesPerYear })),
  };
}

// ---------------------------------------------------------------------------------------------
// Flash messages (`?plans=<key>` / `?plansError=<key>`) and SQL error codes

export const PLAN_DONE_MESSAGES: Record<string, string> = {
  plan_added: "Plan added. Customers can join it on your booking site now.",
  plan_saved: "Plan saved. A new price applies to new sign-ups only.",
  plan_archived: "Plan archived. No new sign-ups; customers already on it carry on.",
  plan_restored: "Plan restored. Customers can join it again.",
  cancelled: "Plan cancelled. The Direct Debit has been stopped.",
  benefit_used: "Included service recorded for this booking.",
  benefit_released: "Included service given back.",
  benefit_none: "Nothing recorded: the car's plan doesn't include this service, or it's already been used this plan year.",
  invoice_applied: "Plan benefits added to the draft invoice.",
};

const ERROR_MESSAGES: Record<string, string> = {
  PLAN_REQUIRED: "Service plans are part of Pro. Upgrade to change plans.",
  SERVICE_PLANS_FORBIDDEN: "Your role can't do that. Ask the owner or a manager.",
  SERVICE_PLAN_NOT_FOUND: "That plan wasn't found. Refresh and try again.",
  SUBSCRIPTION_NOT_FOUND: "That plan subscription wasn't found. Refresh and try again.",
  BOOKING_NOT_FOUND: "That booking wasn't found. Refresh and try again.",
  INVALID_PLAN: "Check the plan's details and try again.",
  INVOICE_NOT_FOUND: "That invoice wasn't found.",
  INVOICE_NOT_DRAFT: "Plan benefits can only be added to a draft invoice.",
  NOT_ON_PLAN: "This car isn't on an active plan.",
  PLAN_PAST_DUE: "The customer's last Direct Debit payment failed, so plan benefits weren't added. Sort the payment first.",
  NOTHING_TO_APPLY: "Nothing to add: no included service on this booking and the plan has no discount.",
  INVOICE_ITEM_COUNT_INVALID: "The invoice has too many lines.",
  UNAUTHORISED: "Your role can't change invoices.",
  provider: "The Direct Debit couldn't be stopped with the payment provider. Nothing changed. Try again.",
  bad_plan: "Check the plan's details and try again.",
  failed: "That couldn't be saved. Try again.",
};

export function planErrorCode(error: { message?: string | null; code?: string | null } | null | undefined): string {
  const match = /^([A-Z][A-Z_]+)\b/.exec(error?.message ?? "");
  if (match && Object.hasOwn(ERROR_MESSAGES, match[1]!)) return match[1]!;
  if (error?.code === "42501") return "SERVICE_PLANS_FORBIDDEN";
  return "failed";
}

export function planFlash(done: string | undefined, error: string | undefined): { tone: "success" | "error"; text: string } | null {
  if (error) return { tone: "error", text: ERROR_MESSAGES[error] ?? ERROR_MESSAGES.failed! };
  if (done && PLAN_DONE_MESSAGES[done]) return { tone: "success", text: PLAN_DONE_MESSAGES[done]! };
  return null;
}

/** Pages the plan actions may return to. */
export function safePlanReturn(value: FormDataEntryValue | null): string {
  const raw = typeof value === "string" ? value : "";
  if (/^\/app\/(bookings|customers|invoices)\/[0-9a-f-]{36}$/i.test(raw)) return raw;
  return "/app/service-plans";
}

/** `returnTo` with a flash; detail pages get a `#service-plan` anchor. */
export function withPlanFlash(returnTo: string, kind: "done" | "error", key: string): string {
  const [path, query = ""] = returnTo.split("?");
  const params = new URLSearchParams(query);
  params.set(kind === "done" ? "plans" : "plansError", key);
  const anchor = path === "/app/service-plans" ? "" : "#service-plan";
  return `${path}?${params.toString()}${anchor}`;
}

// ---------------------------------------------------------------------------------------------
// The Direct Debit Guarantee (Bacs wording; must be shown before the customer sets up a mandate).

export const DIRECT_DEBIT_GUARANTEE: readonly string[] = [
  "The Guarantee is offered by all banks and building societies that accept instructions to pay Direct Debits.",
  "If there are any changes to the amount, date or frequency of your Direct Debit, {payee} will notify you (normally 3 working days) in advance of your account being debited or as otherwise agreed. If you request {payee} to collect a payment, confirmation of the amount and date will be given to you at the time of the request.",
  "If an error is made in the payment of your Direct Debit, by {payee} or your bank or building society, you are entitled to a full and immediate refund of the amount paid from your bank or building society.",
  "If you receive a refund you are not entitled to, you must pay it back when {payee} asks you to.",
  "You can cancel a Direct Debit at any time by simply contacting your bank or building society. Written confirmation may be required. Please also notify us.",
];

export function guaranteeParagraphs(payee: string): string[] {
  return DIRECT_DEBIT_GUARANTEE.map((paragraph) => paragraph.replaceAll("{payee}", payee));
}
