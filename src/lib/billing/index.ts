import { createMockBillingProvider } from "./mock";
import type { BillingProvider } from "./provider";
import { createStripeBillingProvider, type StripeBillingConfig } from "./stripe";

export type { BillingEvent, BillingGarage, BillingProvider, BillingProviderKind, SubscriptionState, UpgradeResult } from "./provider";

type Env = Record<string, string | undefined>;

export type BillingReadiness =
  /** Default: no Stripe; upgrades are requests to Vitalos. */
  | "mock"
  | "stripe_test"
  /** BILLING_PROVIDER=stripe but a key, price or webhook secret is missing. */
  | "configuration_required"
  /** A live key was supplied: refused until Temitope approves live billing. */
  | "live_key_refused";

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^(sk|rk)_live_/;
const PRICE = /^price_[A-Za-z0-9]+$/;
const TAX_RATE = /^txr_[A-Za-z0-9]+$/;

export function readStripeBillingConfig(env: Env): { readiness: BillingReadiness; config: StripeBillingConfig | null } {
  if (env.BILLING_PROVIDER !== "stripe") return { readiness: "mock", config: null };
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (LIVE_KEY.test(secretKey)) return { readiness: "live_key_refused", config: null };
  const webhookSecret = env.STRIPE_BILLING_WEBHOOK_SECRET?.trim() ?? "";
  const proPriceId = env.STRIPE_PRICE_PRO?.trim() ?? "";
  const extra = env.STRIPE_PRICE_EXTRA_SITE?.trim() ?? "";
  const vat = env.STRIPE_VAT_TAX_RATE?.trim() ?? "";
  if (!TEST_KEY.test(secretKey) || !webhookSecret.startsWith("whsec_") || !PRICE.test(proPriceId)) {
    return { readiness: "configuration_required", config: null };
  }
  return {
    readiness: "stripe_test",
    config: { secretKey, webhookSecret, proPriceId, extraSitePriceId: PRICE.test(extra) ? extra : null, vatTaxRateId: TAX_RATE.test(vat) ? vat : null },
  };
}

export function getBillingReadiness(env: Env = process.env): BillingReadiness {
  return readStripeBillingConfig(env).readiness;
}

/** True when Stripe Checkout adds VAT (STRIPE_VAT_TAX_RATE set), so the upgrade step may say so (D25). */
export function checkoutAddsVat(env: Env = process.env): boolean {
  return readStripeBillingConfig(env).config?.vatTaxRateId != null;
}

/**
 * The billing provider: Stripe (test mode) when `BILLING_PROVIDER=stripe` with a test key, price and
 * webhook secret; otherwise the mock. A live key or an incomplete Stripe setup falls back to the mock,
 * so upgrades become requests to Vitalos instead of failing.
 */
export function getBillingProvider(env: Env = process.env): BillingProvider {
  const { config } = readStripeBillingConfig(env);
  return config ? createStripeBillingProvider(config) : createMockBillingProvider();
}
