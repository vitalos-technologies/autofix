import type { MandateRequest, MandateResult, MandateState, PaymentsEvent, PlanSubscriptionStatus } from "./provider";

// Stripe Bacs Direct Debit for customer service plans (P5.11), TEST MODE ONLY, on the garage's own
// connected account (`Stripe-Account: acct_…`), with fetch over Stripe's REST API like ./stripe.ts.
//
//   start    POST /v1/checkout/sessions mode=subscription, payment_method_types[]=bacs_debit, one GBP
//            line with recurring[interval]=month, metadata + subscription_data[metadata] carrying our
//            plan_subscription_id and garage_id. Stripe's hosted page collects the bank details, shows the
//            Direct Debit mandate and sends the advance notice emails; we never see bank details.
//   read     GET /v1/checkout/sessions/{id}?expand[]=subscription (the customer came back first).
//   cancel   DELETE /v1/subscriptions/{id} (staff cancelled the plan).
//   events   checkout.session.completed (refs), customer.subscription.created|updated|deleted (status),
//            invoice.payment_failed (past due), invoice.paid (active again). The event's `account` must be
//            the garage's own account (checked again in applyPaymentsEvent()). Live events are ignored.
//
// GoCardless would implement the same three PaymentsProvider methods (A381); it is not built.

type Call = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: Record<string, string | number | undefined | null> | null,
  options?: { account?: string; idempotencyKey?: string },
) => Promise<{ ok: boolean; json: Record<string, unknown> | null }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^acct_[A-Za-z0-9]{6,64}$/;
const CHECKOUT = /^cs_(test_)?[A-Za-z0-9]{6,200}$/;
const SUBSCRIPTION = /^sub_[A-Za-z0-9_]{6,200}$/;

/** Stripe's subscription status as ours; null = no change (incomplete, paused, unknown). */
export function planStatusFromStripe(status: unknown): PlanSubscriptionStatus | null {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled" || status === "incomplete_expired") return "cancelled";
  return null;
}

type StripeSubscription = {
  id?: string;
  status?: string;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_end?: number }> };
  default_payment_method?: string | { id?: string } | null;
  metadata?: Record<string, string>;
};

function periodEnd(subscription: StripeSubscription): string | null {
  // API versions before 2025-03 keep it on the subscription, later ones on each item.
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}

export function stripeMandateMethods(call: Call) {
  return {
    async startMandate({ accountRef, subscriptionId, garageId, amountPence, description, customerEmail, successUrl, cancelUrl }: MandateRequest): Promise<MandateResult> {
      if (!ACCOUNT.test(accountRef) || !UUID.test(subscriptionId)) return { kind: "error", code: "provider_error" };
      try {
        const { ok, json } = await call("POST", "/checkout/sessions", {
          mode: "subscription",
          "payment_method_types[0]": "bacs_debit",
          "line_items[0][quantity]": 1,
          "line_items[0][price_data][currency]": "gbp",
          "line_items[0][price_data][unit_amount]": amountPence,
          "line_items[0][price_data][recurring][interval]": "month",
          "line_items[0][price_data][product_data][name]": description.slice(0, 200),
          client_reference_id: subscriptionId,
          "metadata[plan_subscription_id]": subscriptionId,
          "metadata[garage_id]": garageId,
          "subscription_data[metadata][plan_subscription_id]": subscriptionId,
          "subscription_data[metadata][garage_id]": garageId,
          customer_email: customerEmail ?? undefined,
          success_url: successUrl,
          cancel_url: cancelUrl,
        }, { account: accountRef, idempotencyKey: `mandate:${subscriptionId}:${Math.floor(Date.now() / 600_000)}` });
        const url = typeof json?.url === "string" ? json.url : null;
        const id = typeof json?.id === "string" ? json.id : null;
        return ok && url?.startsWith("https://") && id && CHECKOUT.test(id) ? { kind: "redirect", url, checkoutRef: id } : { kind: "error", code: "provider_error" };
      } catch {
        return { kind: "error", code: "provider_error" };
      }
    },

    async getMandate({ accountRef, checkoutRef }: { accountRef: string; checkoutRef: string }): Promise<MandateState | null> {
      if (!ACCOUNT.test(accountRef) || !CHECKOUT.test(checkoutRef)) return null;
      try {
        const { ok, json } = await call("GET", `/checkout/sessions/${checkoutRef}?expand[]=subscription`, null, { account: accountRef });
        if (!ok || !json || json.status !== "complete") return null;
        const subscription = (typeof json.subscription === "object" && json.subscription ? json.subscription : null) as StripeSubscription | null;
        const subscriptionRef = idOf(json.subscription);
        return {
          status: subscription ? planStatusFromStripe(subscription.status) : null,
          subscriptionRef: subscriptionRef && SUBSCRIPTION.test(subscriptionRef) ? subscriptionRef : null,
          mandateRef: subscription ? idOf(subscription.default_payment_method) : null,
          renewsAt: subscription ? periodEnd(subscription) : null,
        };
      } catch {
        return null;
      }
    },

    async cancelMandate({ accountRef, subscriptionRef }: { accountRef: string; subscriptionRef: string }): Promise<boolean> {
      if (!ACCOUNT.test(accountRef) || !SUBSCRIPTION.test(subscriptionRef)) return false;
      try {
        const { ok, json } = await call("DELETE", `/subscriptions/${subscriptionRef}`, null, { account: accountRef });
        // Already cancelled (or gone): nothing left to stop.
        return ok || (json?.error as { code?: string } | undefined)?.code === "resource_missing";
      } catch {
        return false;
      }
    },
  };
}

type StripeEvent = { id: string; type: string; account?: string; data?: { object?: Record<string, unknown> } };

/**
 * Maps a verified Connect event about a plan's Direct Debit, or returns null when it is not one (the
 * P5.4 mapping then runs). Exported for tests.
 */
export function mapStripePlanEvent(event: StripeEvent): PaymentsEvent | null {
  const object = event.data?.object;
  if (!object) return null;
  const accountRef = typeof event.account === "string" && ACCOUNT.test(event.account) ? event.account : "";
  const base = { kind: "plan_subscription" as const, eventId: event.id, type: event.type, accountRef };
  const ignored = { kind: "ignored" as const, eventId: event.id, type: event.type };
  const ours = (metadata: Record<string, string> | undefined) => {
    const subscriptionId = metadata?.plan_subscription_id ?? "";
    const garageId = metadata?.garage_id ?? "";
    return UUID.test(subscriptionId) && UUID.test(garageId) ? { subscriptionId: subscriptionId.toLowerCase(), garageId: garageId.toLowerCase() } : null;
  };

  if (event.type === "checkout.session.completed" && object.mode === "subscription") {
    const ids = ours(object.metadata as Record<string, string> | undefined);
    if (!ids) return null;
    if (!accountRef) return ignored;
    const subscriptionRef = idOf(object.subscription);
    return { ...base, ...ids, status: null, subscriptionRef: subscriptionRef && SUBSCRIPTION.test(subscriptionRef) ? subscriptionRef : null, mandateRef: null, renewsAt: null };
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscription = object as StripeSubscription;
    const ids = ours(subscription.metadata);
    if (!ids) return null;
    if (!accountRef || !subscription.id || !SUBSCRIPTION.test(subscription.id)) return ignored;
    return {
      ...base,
      ...ids,
      status: event.type === "customer.subscription.deleted" ? "cancelled" : planStatusFromStripe(subscription.status),
      subscriptionRef: subscription.id,
      mandateRef: idOf(subscription.default_payment_method),
      renewsAt: periodEnd(subscription),
    };
  }

  if (event.type === "invoice.payment_failed" || event.type === "invoice.paid") {
    // The subscription's metadata is copied onto the invoice (older API versions: subscription_details,
    // later ones: parent.subscription_details).
    const parent = object.parent as { subscription_details?: { metadata?: Record<string, string>; subscription?: unknown } } | undefined;
    const details = (object.subscription_details as { metadata?: Record<string, string> } | undefined) ?? parent?.subscription_details;
    const ids = ours(details?.metadata);
    if (!ids) return null;
    const subscriptionRef = idOf(object.subscription) ?? idOf(parent?.subscription_details?.subscription);
    if (!accountRef || !subscriptionRef || !SUBSCRIPTION.test(subscriptionRef)) return ignored;
    return { ...base, ...ids, status: event.type === "invoice.paid" ? "active" : "past_due", subscriptionRef, mandateRef: null, renewsAt: null };
  }
  return null;
}
