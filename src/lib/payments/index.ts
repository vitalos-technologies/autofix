import { createMockPaymentsProvider } from "./mock";
import type { PaymentsProvider } from "./provider";
import { createStripePaymentsProvider, type StripePaymentsConfig } from "./stripe";

export type {
  AccountState,
  CheckoutRequest,
  CheckoutResult,
  CheckoutState,
  ConnectGarage,
  ConnectResult,
  MandateRequest,
  MandateResult,
  MandateState,
  PaymentAccountStatus,
  PaymentsEvent,
  PaymentsProvider,
  PaymentsProviderKind,
  PlanSubscriptionStatus,
} from "./provider";

type Env = Readonly<Record<string, string | undefined>>;

export type PaymentsReadiness =
  /** Default: the mock provider (no money moves). */
  | "mock"
  | "stripe_test"
  /** PAYMENTS_PROVIDER=stripe but the test key or the webhook secret is missing. */
  | "configuration_required"
  /** A live key was supplied: refused until Temitope approves live payments. */
  | "live_key_refused"
  /** The mock never takes "payments" on the production deployment. */
  | "mock_not_in_production";

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^(sk|rk)_live_/;

/**
 * Which payments provider this deployment may use. Stripe Connect is TEST MODE ONLY, exactly as
 * billing (src/lib/billing/index.ts): a live key is refused. Unlike billing, nothing falls back to the
 * mock when Stripe is asked for but not ready, and the mock is refused on Vercel production: a
 * customer must never "pay" on a page where no money moves.
 */
export function readPaymentsConfig(env: Env): { readiness: PaymentsReadiness; config: StripePaymentsConfig | null } {
  const requested = env.PAYMENTS_PROVIDER?.trim() || "mock";
  if (requested === "stripe") {
    const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
    if (LIVE_KEY.test(secretKey)) return { readiness: "live_key_refused", config: null };
    const webhookSecret = env.STRIPE_PAYMENTS_WEBHOOK_SECRET?.trim() ?? "";
    if (!TEST_KEY.test(secretKey) || !webhookSecret.startsWith("whsec_")) return { readiness: "configuration_required", config: null };
    return { readiness: "stripe_test", config: { secretKey, webhookSecret } };
  }
  if (env.VERCEL_ENV === "production") return { readiness: "mock_not_in_production", config: null };
  return { readiness: "mock", config: null };
}

export function getPaymentsReadiness(env: Env = process.env): PaymentsReadiness {
  return readPaymentsConfig(env).readiness;
}

/** The provider, or null when payments cannot be taken on this deployment (see PaymentsReadiness). */
export function getPaymentsProvider(env: Env = process.env): PaymentsProvider | null {
  const { readiness, config } = readPaymentsConfig(env);
  if (readiness === "stripe_test" && config) return createStripePaymentsProvider(config);
  if (readiness === "mock") return createMockPaymentsProvider();
  return null;
}

export const PAYMENTS_READINESS_MESSAGES: Record<Exclude<PaymentsReadiness, "mock" | "stripe_test">, string> = {
  configuration_required: "Card payments aren't set up on Autofix yet. Vitalos is finishing the setup.",
  live_key_refused: "Card payments aren't switched on for live use yet.",
  mock_not_in_production: "Card payments aren't switched on yet. Vitalos will tell you when they are.",
};
