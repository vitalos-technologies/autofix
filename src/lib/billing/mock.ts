import type { BillingProvider } from "./provider";

/**
 * The mock provider (default): no checkout, no portal. Upgrading records a plan request for Vitalos
 * ("Request Pro"); extra sites are recorded on the garage's subscription row only. Never touches the
 * network and accepts no webhooks.
 */
export function createMockBillingProvider(): BillingProvider {
  return {
    kind: "mock",
    async startUpgrade() {
      return { kind: "request" };
    },
    async openPortal() {
      return null;
    },
    async setExtraSites() {
      return { ok: true };
    },
    async changePlan() {
      return { ok: false, code: "no_subscription" };
    },
    async setCancelAtPeriodEnd() {
      return { ok: false, code: "no_subscription" };
    },
    parseWebhook() {
      return null;
    },
  };
}
