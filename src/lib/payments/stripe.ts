import { verifyStripeSignature } from "@/lib/billing/stripe";
import type { AccountState, PaymentsEvent, PaymentsProvider } from "./provider";
import { mapStripePlanEvent, stripeMandateMethods } from "./stripe-direct-debit";

// Stripe Connect for garages' own payments (P5.4), TEST MODE ONLY, over Stripe's REST API with fetch
// (no SDK), as src/lib/billing/stripe.ts does for Pitline's own plans.
//
//   connect   POST /v1/accounts (Express, GB, metadata garage_id) once, then POST /v1/account_links
//             (account_onboarding) each time the owner continues; GET /v1/accounts/{id} for status.
//   collect   POST /v1/checkout/sessions with `Stripe-Account: acct_…` (a direct charge on the garage's
//             account, mode=payment, GBP), metadata payment_id + garage_id; expire with
//             POST /v1/checkout/sessions/{id}/expire. No application fee (A320).
//   webhooks  A Connect endpoint (`STRIPE_PAYMENTS_WEBHOOK_SECRET`): checkout.session.completed /
//             async_payment_succeeded (paid), account.updated. The event's `account` must be the
//             garage's own account (checked again in apply_payment_paid() callers). Live events ignored.
//
// Ids only travel to Stripe: our payment and garage ids, an amount and a description such as
// "Invoice INV-2026-000012". Never a registration, phone number or email.

export type StripePaymentsConfig = { secretKey: string; webhookSecret: string };

type Fetch = typeof fetch;

const API = "https://api.stripe.com/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^acct_[A-Za-z0-9]{6,64}$/;
const CHECKOUT = /^cs_(test_)?[A-Za-z0-9]{6,200}$/;
/** Stripe's limits on Checkout's expires_at: 30 minutes to 24 hours from now. */
const MIN_EXPIRY_S = 30 * 60 + 30;
const MAX_EXPIRY_S = 24 * 60 * 60 - 60;

function form(values: Record<string, string | number | undefined | null>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  return body.toString();
}

type StripeAccount = { id?: string; charges_enabled?: boolean; details_submitted?: boolean; metadata?: Record<string, string> };

export function accountState(account: StripeAccount): AccountState | null {
  if (!account.id || !ACCOUNT.test(account.id)) return null;
  const chargesEnabled = account.charges_enabled === true;
  return {
    accountRef: account.id,
    chargesEnabled,
    status: chargesEnabled ? "active" : account.details_submitted ? "restricted" : "pending",
  };
}

/** Checkout's expires_at for a payment that must stop at `expiresAt`, within Stripe's limits. */
export function checkoutExpiry(expiresAt: Date, now: Date = new Date()): number {
  const nowS = Math.floor(now.getTime() / 1000);
  const wanted = Math.floor(expiresAt.getTime() / 1000);
  return Math.min(nowS + MAX_EXPIRY_S, Math.max(nowS + MIN_EXPIRY_S, wanted));
}

export function createStripePaymentsProvider(config: StripePaymentsConfig, fetcher: Fetch = fetch): PaymentsProvider {
  async function call(method: "GET" | "POST" | "DELETE", path: string, body: Record<string, string | number | undefined | null> | null, options: { account?: string; idempotencyKey?: string } = {}) {
    const response = await fetcher(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(options.account ? { "Stripe-Account": options.account } : {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: body ? form(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, json };
  }

  return {
    kind: "stripe",
    // P5.11: Bacs Direct Debit for service plans (./stripe-direct-debit.ts).
    ...stripeMandateMethods(call),
    async startConnect({ garage, accountRef, returnUrl, refreshUrl }) {
      try {
        let account = accountRef && ACCOUNT.test(accountRef) ? accountRef : null;
        if (!account) {
          const created = await call("POST", "/accounts", {
            type: "express",
            country: "GB",
            default_currency: "gbp",
            "capabilities[card_payments][requested]": "true",
            "capabilities[transfers][requested]": "true",
            "business_profile[name]": garage.name.slice(0, 100),
            email: garage.email ?? undefined,
            "metadata[garage_id]": garage.id,
          }, { idempotencyKey: `connect-account:${garage.id}` });
          const id = typeof created.json?.id === "string" ? created.json.id : null;
          if (!created.ok || !id || !ACCOUNT.test(id)) return { kind: "error", code: "provider_error" };
          account = id;
        }
        const link = await call("POST", "/account_links", { account, refresh_url: refreshUrl, return_url: returnUrl, type: "account_onboarding" });
        const url = typeof link.json?.url === "string" ? link.json.url : null;
        return link.ok && url?.startsWith("https://") ? { kind: "redirect", url, accountRef: account } : { kind: "error", code: "provider_error" };
      } catch {
        return { kind: "error", code: "provider_error" };
      }
    },
    async getAccount(accountRef) {
      if (!ACCOUNT.test(accountRef)) return null;
      try {
        const { ok, json } = await call("GET", `/accounts/${accountRef}`, null);
        return ok && json ? accountState(json as StripeAccount) : null;
      } catch {
        return null;
      }
    },
    async createCheckout({ accountRef, paymentId, garageId, amountPence, description, successUrl, cancelUrl, expiresAt }) {
      if (!ACCOUNT.test(accountRef)) return { kind: "error", code: "provider_error" };
      try {
        const { ok, json } = await call("POST", "/checkout/sessions", {
          mode: "payment",
          "line_items[0][quantity]": 1,
          "line_items[0][price_data][currency]": "gbp",
          "line_items[0][price_data][unit_amount]": amountPence,
          "line_items[0][price_data][product_data][name]": description.slice(0, 200),
          client_reference_id: paymentId,
          "metadata[payment_id]": paymentId,
          "metadata[garage_id]": garageId,
          "payment_intent_data[metadata][payment_id]": paymentId,
          "payment_intent_data[metadata][garage_id]": garageId,
          success_url: successUrl,
          cancel_url: cancelUrl,
          expires_at: checkoutExpiry(expiresAt),
        }, { account: accountRef, idempotencyKey: `checkout:${paymentId}:${Math.floor(expiresAt.getTime() / 1000)}` });
        const url = typeof json?.url === "string" ? json.url : null;
        const id = typeof json?.id === "string" ? json.id : null;
        return ok && url?.startsWith("https://") && id && CHECKOUT.test(id) ? { kind: "redirect", url, checkoutRef: id } : { kind: "error", code: "provider_error" };
      } catch {
        return { kind: "error", code: "provider_error" };
      }
    },
    async getCheckout({ accountRef, checkoutRef }) {
      if (!ACCOUNT.test(accountRef) || !CHECKOUT.test(checkoutRef)) return null;
      try {
        const { ok, json } = await call("GET", `/checkout/sessions/${checkoutRef}`, null, { account: accountRef });
        if (!ok || !json) return null;
        const intent = json.payment_intent;
        return {
          paid: json.payment_status === "paid",
          amountPence: typeof json.amount_total === "number" ? json.amount_total : null,
          providerPaymentRef: typeof intent === "string" ? intent : null,
        };
      } catch {
        return null;
      }
    },
    async cancelCheckout({ accountRef, checkoutRef }) {
      if (!ACCOUNT.test(accountRef) || !CHECKOUT.test(checkoutRef)) return false;
      try {
        const { ok, json } = await call("POST", `/checkout/sessions/${checkoutRef}/expire`, {}, { account: accountRef });
        // Already expired or complete: nothing left to close.
        return ok || (json?.error as { code?: string } | undefined)?.code === "checkout_session_expired" || false;
      } catch {
        return false;
      }
    },
    parseWebhook(rawBody, signatureHeader, now) {
      if (!verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret, now)) return null;
      return mapStripePaymentsEvent(rawBody);
    },
  };
}

type StripeCheckoutSession = {
  id?: string;
  payment_status?: string;
  amount_total?: number;
  payment_intent?: string | { id?: string } | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
};

/** Maps a verified Connect event body. Exported for tests. */
export function mapStripePaymentsEvent(rawBody: string): PaymentsEvent | null {
  let event: { id?: string; type?: string; livemode?: boolean; account?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const eventId = typeof event.id === "string" ? event.id : "";
  const type = typeof event.type === "string" ? event.type : "";
  if (!eventId || !type) return null;
  const ignored = { kind: "ignored" as const, eventId, type };
  // Test mode only: a live event is never applied.
  if (event.livemode === true) return ignored;
  const object = event.data?.object;
  if (!object) return ignored;
  // P5.11: a service plan's Direct Debit (checked first: its checkout sessions carry no payment_id).
  const plan = mapStripePlanEvent({ id: eventId, type, account: event.account, data: event.data });
  if (plan) return plan;

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const session = object as StripeCheckoutSession;
    const paymentId = session.metadata?.payment_id ?? session.client_reference_id ?? "";
    const garageId = session.metadata?.garage_id ?? "";
    const accountRef = typeof event.account === "string" ? event.account : "";
    if (session.payment_status !== "paid" || !UUID.test(paymentId) || !UUID.test(garageId) || !ACCOUNT.test(accountRef)) return ignored;
    const intent = session.payment_intent;
    return {
      kind: "paid",
      eventId,
      type,
      accountRef,
      garageId: garageId.toLowerCase(),
      paymentId: paymentId.toLowerCase(),
      amountPence: typeof session.amount_total === "number" ? session.amount_total : null,
      providerPaymentRef: typeof intent === "string" ? intent : intent?.id ?? null,
    };
  }

  if (type === "account.updated") {
    const account = object as StripeAccount;
    const garageId = account.metadata?.garage_id ?? "";
    const state = accountState(account);
    if (!state || !UUID.test(garageId)) return ignored;
    return { kind: "account", eventId, type, garageId: garageId.toLowerCase(), account: state };
  }
  return ignored;
}
