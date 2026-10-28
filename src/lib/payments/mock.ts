import { createHash } from "node:crypto";
import type { PaymentsProvider } from "./provider";

/**
 * The mock provider (default, `PAYMENTS_PROVIDER=mock`): connecting succeeds at once with a mock
 * account, and the garage host's /pay page takes a test payment itself (no card details, no money).
 * Never touches the network and accepts no webhooks. Refused on Vercel production (./index.ts).
 */
export function createMockPaymentsProvider(): PaymentsProvider {
  return {
    kind: "mock",
    async startConnect({ garage, accountRef }) {
      const ref = accountRef?.startsWith("mock_acct_")
        ? accountRef
        : `mock_acct_${createHash("sha256").update(garage.id).digest("hex").slice(0, 16)}`;
      return { kind: "connected", account: { accountRef: ref, status: "active", chargesEnabled: true } };
    },
    async getAccount(accountRef) {
      return accountRef.startsWith("mock_acct_") ? { accountRef, status: "active", chargesEnabled: true } : null;
    },
    async createCheckout() {
      return { kind: "local" };
    },
    async getCheckout() {
      return null;
    },
    async cancelCheckout() {
      return true;
    },
    // P5.11: the mock "sets up" a Direct Debit on the garage host's plan confirm page.
    async startMandate() {
      return { kind: "local" };
    },
    async getMandate() {
      return null;
    },
    async cancelMandate() {
      return true;
    },
    parseWebhook() {
      return null;
    },
  };
}
