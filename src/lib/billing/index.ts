import { createMockBillingProvider } from "./mock";
import type { BillingProvider } from "./provider";
import { createStripeBillingProvider, type StripeBillingConfig } from "./stripe";

export type { BillingEvent, BillingGarage, BillingProvider, BillingProviderKind, SubscriptionState, UpgradeResult } from "./provider";

type Env = Record<string, string | undefined>;

export type BillingReadiness =
  /** Default: no Stripe; upgrades are requests to Vitalos. */
  | "mock"
  | "stripe_test"
  /** STRIPE_LIVE_MODE=true with a live key (D26). */
  | "stripe_live"
  /** BILLING_PROVIDER=stripe but a key, price or webhook secret is missing. */
  | "configuration_required"
  /** A live key without STRIPE_LIVE_MODE=true: refused, as before D26. */
  | "live_key_refused"
  /** STRIPE_LIVE_MODE=true with a test key: refused, so live mode is never half set up. */
  | "test_key_refused";

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^(sk|rk)_live_[A-Za-z0-9]+$/;
const PRICE = /^price_[A-Za-z0-9]+$/;

/** STRIPE_LIVE_MODE=true switches Pitline's own billing to live keys (D26). Anything else is test mode. */
export function stripeLiveMode(env: Env = process.env): boolean {
  return env.STRIPE_LIVE_MODE?.trim().toLowerCase() === "true";
}

/** BILLING_COLLECT_VAT=true makes Checkout add VAT with Stripe Tax (D26). Default off: Vitalos is not VAT registered yet. */
export function billingCollectsVat(env: Env = process.env): boolean {
  return env.BILLING_COLLECT_VAT?.trim().toLowerCase() === "true";
}

export function readStripeBillingConfig(env: Env): { readiness: BillingReadiness; config: StripeBillingConfig | null } {
  if (env.BILLING_PROVIDER !== "stripe") return { readiness: "mock", config: null };
  const liveMode = stripeLiveMode(env);
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!liveMode && LIVE_KEY.test(secretKey)) return { readiness: "live_key_refused", config: null };
  if (liveMode && TEST_KEY.test(secretKey)) return { readiness: "test_key_refused", config: null };
  const webhookSecret = env.STRIPE_BILLING_WEBHOOK_SECRET?.trim() ?? "";
  const proPriceId = env.STRIPE_PRICE_PRO?.trim() ?? "";
  const essentials = env.STRIPE_PRICE_ESSENTIALS?.trim() ?? "";
  const extra = env.STRIPE_PRICE_EXTRA_SITE?.trim() ?? "";
  if (!(liveMode ? LIVE_KEY : TEST_KEY).test(secretKey) || !webhookSecret.startsWith("whsec_") || !PRICE.test(proPriceId)) {
    return { readiness: "configuration_required", config: null };
  }
  return {
    readiness: liveMode ? "stripe_live" : "stripe_test",
    config: {
      secretKey,
      webhookSecret,
      proPriceId,
      essentialsPriceId: PRICE.test(essentials) ? essentials : null,
      extraSitePriceId: PRICE.test(extra) ? extra : null,
      liveMode,
      collectVat: billingCollectsVat(env),
    },
  };
}

export function getBillingReadiness(env: Env = process.env): BillingReadiness {
  return readStripeBillingConfig(env).readiness;
}

/** True when garages pay Pitline through Stripe Checkout (test or live), not by request to Vitalos. */
export function billingSelfServe(readiness: BillingReadiness): boolean {
  return readiness === "stripe_test" || readiness === "stripe_live";
}

/** True when Stripe Checkout adds VAT, so the payment step may say so (D26). */
export function checkoutAddsVat(env: Env = process.env): boolean {
  return readStripeBillingConfig(env).config?.collectVat === true;
}

/**
 * The billing provider: Stripe when `BILLING_PROVIDER=stripe` with a key of the right mode (test, or
 * live with STRIPE_LIVE_MODE=true), a price and a webhook secret; otherwise the mock. A refused key or
 * an incomplete Stripe setup falls back to the mock, so upgrades become requests to Vitalos.
 */
export function getBillingProvider(env: Env = process.env): BillingProvider {
  const { config } = readStripeBillingConfig(env);
  return config ? createStripeBillingProvider(config) : createMockBillingProvider();
}
