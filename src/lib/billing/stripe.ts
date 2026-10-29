import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProvider, SubscriptionState, SubscriptionStatus } from "./provider";

// Stripe Billing for Pitline's own plans (P5.2), TEST MODE ONLY, over Stripe's REST API with fetch
// (no SDK). Checkout (mode=subscription) to upgrade, the customer portal, a quantity line for extra
// sites, and signed webhooks (`Stripe-Signature`, HMAC-SHA-256 over "<t>.<raw body>", 5-minute
// tolerance). The garage id travels as `client_reference_id` and subscription metadata `garage_id`,
// and is checked against our own row by apply_billing_subscription(); never a registration or email.

export type StripeBillingConfig = {
  secretKey: string;
  webhookSecret: string;
  proPriceId: string;
  extraSitePriceId: string | null;
};

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

  return {
    kind: "stripe",
    async startUpgrade({ garage, customerRef, successUrl, cancelUrl }) {
      try {
        const { ok, json } = await call("/checkout/sessions", {
          mode: "subscription",
          "line_items[0][price]": config.proPriceId,
          "line_items[0][quantity]": 1,
          client_reference_id: garage.id,
          "metadata[garage_id]": garage.id,
          "subscription_data[metadata][garage_id]": garage.id,
          customer: customerRef ?? undefined,
          customer_email: customerRef ? undefined : garage.email ?? undefined,
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
      // Test mode only: a live event is never applied.
      if (event.livemode === true) return { kind: "ignored", eventId, type };
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
