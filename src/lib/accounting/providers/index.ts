// Which AccountingProvider serves a provider id (P5.10).
//
// ACCOUNTING_PROVIDER_MODE=fake (the default) serves every provider choice with the fake, labelled
// "(test mode)", so the whole flow works in development, tests and e2e without accounts. Any other
// value (`live`) uses the real adapters; one without its client id and secret reports
// `configured: false` and the settings page shows "Configuration required".

import type { FetchLike } from "../http";
import { ACCOUNTING_PROVIDER_NAMES, type AccountingProvider, type AccountingProviderId } from "../types";
import { createFakeProvider } from "./fake";
import { createQuickBooksProvider } from "./quickbooks";
import { createSageProvider } from "./sage";
import { createXeroProvider } from "./xero";

export type AccountingMode = "fake" | "live";

export function accountingMode(env: Readonly<Record<string, string | undefined>> = process.env): AccountingMode {
  return env.ACCOUNTING_PROVIDER_MODE?.trim().toLowerCase() === "live" ? "live" : "fake";
}

export type ProviderOptions = { env?: Readonly<Record<string, string | undefined>>; fetch?: FetchLike; now?: () => Date };

export function getAccountingProvider(id: AccountingProviderId, options: ProviderOptions = {}): AccountingProvider {
  const env = options.env ?? process.env;
  if (id === "fake" || accountingMode(env) === "fake") {
    const fake = createFakeProvider({ now: options.now });
    if (id === "fake") return fake;
    return { ...fake, id, name: `${ACCOUNTING_PROVIDER_NAMES[id]} (test mode)` };
  }
  switch (id) {
    case "xero":
      return createXeroProvider(options);
    case "quickbooks":
      return createQuickBooksProvider(options);
    case "sage":
      return createSageProvider(options);
  }
}

/** Env var names each live provider needs (for the docs and the settings page; never values). */
export const PROVIDER_ENV_VARS: Record<Exclude<AccountingProviderId, "fake">, readonly string[]> = {
  xero: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
  quickbooks: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_ENVIRONMENT"],
  sage: ["SAGE_CLIENT_ID", "SAGE_CLIENT_SECRET"],
};
