import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProvider, SubscriptionState, SubscriptionStatus } from "./provider";

// Stripe Billing for Pitline's own plans (P5.2), over Stripe's REST API with fetch (no SDK). Test mode
// unless STRIPE_LIVE_MODE=true (D26). Checkout (mode=subscription, card always collected, the garage's
// free month as the Stripe trial: D26) for either plan, plan changes and cancel-at-period-end on the
// subscription, the customer portal, a quantity line for extra sites, and signed webhooks (`Stripe-Signature`, HMAC-SHA-256 over "<t>.<raw body>", 5-minute
// tolerance). The garage id travels as `client_reference_id` and subscription metadata `garage_id`,
// and is checked against our own row by apply_billing_subscription(); never a registration or email.

export type StripeBillingConfig = {
  secretKey: string;
  webhookSecret: string;
  proPriceId: string;
  /** Essentials monthly price; null until stripe-setup has created it (Essentials checkout is then unavailable). */
  essentialsPriceId: string | null;
  extraSitePriceId: string | null;
  /** STRIPE_LIVE_MODE=true: only live keys, and only live events are applied (D26). */
  liveMode: boolean;
  /** BILLING_COLLECT_VAT=true: Checkout adds VAT with Stripe Tax (D26). Prices are ex-VAT (tax_behavior exclusive). */
  collectVat: boolean;
};

/** Stripe needs a trial to end at least 48 hours ahead; a shorter remainder starts billing at once. */
const MIN_TRIAL_MS = 48 * 60 * 60 * 1000;
const PLAN_DESCRIPTIONS = { essentials: "Pitline Essentials", pro: "Pitline Pro" } as const;

type Fetch = typeof fetch;

const API = "https://api.stripe.com/v1";
const TOLERANCE_S = 300;

function form(values: Record<string, string | number | undefined | null>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  return body.toString();
}

/** Parses `t=…,v1=…[,v1=…]`. */
function parseSignature(header: string) {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key?.trim() === "t" && value) timestamp = Number(value);
    if (key?.trim() === "v1" && value) signatures.push(value.trim());
  }
  return { timestamp: Number.isFinite(timestamp) ? timestamp : null, signatures };
}

export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now: Date = new Date()): boolean {
  if (!header || !secret) return false;
  const { timestamp, signatures } = parseSignature(header);
  if (timestamp === null || !signatures.length) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Test helper and contract: the header Stripe would send for this body. */
export function signStripePayload(rawBody: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

const STATUS: Record<string, SubscriptionStatus> = {
  incomplete: "incomplete",
  incomplete_expired: "cancelled",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  canceled: "cancelled",
  paused: "unpaid",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StripeSubscription = {
  id?: string;
  customer?: string | { id?: string };
  status?: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: { data?: { price?: { id?: string }; quantity?: number; current_period_end?: number }[] };
};

export function subscriptionState(subscription: StripeSubscription, config: Pick<StripeBillingConfig, "proPriceId" | "extraSitePriceId">): SubscriptionState | null {
  // Pro when a Pro price is on the subscription; any other plan line (the Essentials price) is Essentials.
  const garageId = subscription.metadata?.garage_id;
  if (!garageId || !UUID.test(garageId) || !subscription.id) return null;
  const items = subscription.items?.data ?? [];
  const pro = items.some((item) => item.price?.id === config.proPriceId);
  const extra = items.find((item) => config.extraSitePriceId && item.price?.id === config.extraSitePriceId);
  const periodEnd = subscription.current_period_end ?? items[0]?.current_period_end;
  return {
    garageId: garageId.toLowerCase(),
    customerRef: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null,
    subscriptionRef: subscription.id,
    status: STATUS[subscription.status ?? ""] ?? "incomplete",
    plan: pro ? "pro" : "essentials",
    currentPeriodEnd: typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null,
    extraSites: Math.max(0, Math.min(100, extra?.quantity ?? 0)),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  };
}

export function createStripeBillingProvider(config: StripeBillingConfig, fetcher: Fetch = fetch): BillingProvider {
  async function call(path: string, body: Record<string, string | number | undefined | null>, idempotencyKey?: string) {
    const response = await fetcher(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: form(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, json };
  }

  async function get(path: string) {
    const response = await fetcher(`${API}${path}`, { headers: { Authorization: `Bearer ${config.secretKey}` }, signal: AbortSignal.timeout(10_000) });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, json };
  }

  function priceFor(plan: "essentials" | "pro") {
    return plan === "pro" ? config.proPriceId : config.essentialsPriceId;
  }

  return {
    kind: "stripe",
    async startUpgrade({ garage, customerRef, successUrl, cancelUrl, plan = "pro", trialEndsAt = null, now = new Date() }) {
      const price = priceFor(plan);
      if (!price) return { kind: "error", code: "configuration_required" };
      // The free month is the Stripe trial, so "£0.00 due today" and the card is charged when it ends.
      const trialEnd = trialEndsAt ? Date.parse(trialEndsAt) : Number.NaN;
      const trial = Number.isFinite(trialEnd) && trialEnd - now.getTime() >= MIN_TRIAL_MS ? Math.floor(trialEnd / 1000) : undefined;
      const vat = config.collectVat;
      try {
        const { ok, json } = await call("/checkout/sessions", {
          mode: "subscription",
          "line_items[0][price]": price,
          "line_items[0][quantity]": 1,
          payment_method_collection: "always",
          client_reference_id: garage.id,
          "metadata[garage_id]": garage.id,
          "subscription_data[metadata][garage_id]": garage.id,
          "subscription_data[description]": PLAN_DESCRIPTIONS[plan],
          "subscription_data[trial_end]": trial,
          "subscription_data[trial_settings][end_behavior][missing_payment_method]": trial ? "cancel" : undefined,
          customer: customerRef ?? undefined,
          customer_email: customerRef ? undefined : garage.email ?? undefined,
          // VAT only where the garage pays, and only once Vitalos collects it (D26).
          "automatic_tax[enabled]": vat ? "true" : undefined,
          "tax_id_collection[enabled]": vat ? "true" : undefined,
          "customer_update[address]": vat && customerRef ? "auto" : undefined,
          "customer_update[name]": vat && customerRef ? "auto" : undefined,
          success_url: successUrl,
          cancel_url: cancelUrl,
          allow_promotion_codes: "true",
        });
        const url = typeof json?.url === "string" ? json.url : null;
        return ok && url?.startsWith("https://") ? { kind: "redirect", url } : { kind: "error", code: "provider_error" };
      } catch {
        return { kind: "error", code: "provider_error" };
      }
    },
    async openPortal({ customerRef, returnUrl }) {
      if (!customerRef) return null;
      try {
        const { ok, json } = await call("/billing_portal/sessions", { customer: customerRef, return_url: returnUrl });
        const url = typeof json?.url === "string" ? json.url : null;
        return ok && url?.startsWith("https://") ? { url } : null;
      } catch {
        return null;
      }
    },
    async setExtraSites({ garageId, subscriptionRef, count }) {
      if (!config.extraSitePriceId) return { ok: false, code: "configuration_required" };
      if (!subscriptionRef) return { ok: false, code: "no_subscription" };
      try {
        const { ok } = await call(
          "/subscription_items",
          { subscription: subscriptionRef, price: config.extraSitePriceId, quantity: Math.max(0, Math.min(100, count)), proration_behavior: "create_prorations" },
          `extra-sites:${garageId}:${subscriptionRef}:${count}`,
        );
        return ok ? { ok: true } : { ok: false, code: "provider_error" };
      } catch {
        return { ok: false, code: "provider_error" };
      }
    },
    async changePlan({ subscriptionRef, plan }) {
      const price = priceFor(plan);
      if (!price) return { ok: false, code: "configuration_required" };
      try {
        const current = await get(`/subscriptions/${encodeURIComponent(subscriptionRef)}`);
        const items = (current.json?.items as { data?: { id?: string; price?: { id?: string } }[] } | undefined)?.data ?? [];
        const planItem = items.find((item) => item.price?.id === config.proPriceId || (config.essentialsPriceId !== null && item.price?.id === config.essentialsPriceId));
        if (!current.ok || !planItem?.id) return { ok: false, code: "provider_error" };
        if (planItem.price?.id === price) return { ok: true };
        const { ok } = await call(`/subscriptions/${encodeURIComponent(subscriptionRef)}`, {
          "items[0][id]": planItem.id,
          "items[0][price]": price,
          proration_behavior: "create_prorations",
          description: PLAN_DESCRIPTIONS[plan],
        });
        return ok ? { ok: true } : { ok: false, code: "provider_error" };
      } catch {
        return { ok: false, code: "provider_error" };
      }
    },
    async setCancelAtPeriodEnd({ subscriptionRef, cancel }) {
      try {
        const { ok } = await call(`/subscriptions/${encodeURIComponent(subscriptionRef)}`, { cancel_at_period_end: cancel ? "true" : "false" });
        return ok ? { ok: true } : { ok: false, code: "provider_error" };
      } catch {
        return { ok: false, code: "provider_error" };
      }
    },
    parseWebhook(rawBody, signatureHeader, now) {
      if (!verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret, now)) return null;
      let event: { id?: string; type?: string; livemode?: boolean; data?: { object?: StripeSubscription } };
      try {
        event = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const eventId = typeof event.id === "string" ? event.id : "";
      const type = typeof event.type === "string" ? event.type : "";
      if (!eventId || !type) return null;
      // Only events of the mode we run in are applied: a test event never changes a live garage (D26).
      if (Boolean(event.livemode) !== config.liveMode) return { kind: "ignored", eventId, type };
      if (type.startsWith("customer.subscription.") && event.data?.object) {
        const state = subscriptionState(event.data.object, config);
        if (!state) return { kind: "ignored", eventId, type };
        if (type === "customer.subscription.deleted") state.status = "cancelled";
        return { kind: "subscription", eventId, type, state };
      }
      return { kind: "ignored", eventId, type };
    },
  };
}
