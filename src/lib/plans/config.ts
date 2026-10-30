// Prices and allowances per plan (D17). NOT SET YET: Temitope sets them (DECISIONS "Waiting on
// Temitope"). Every value below is a PLACEHOLDER (`null` = not set) and can be set without a code
// change through the env vars named next to it. Until a value is set the Plan page says "to be
// confirmed", usage is still counted, and closed months are recorded as not billable.
//
// Client-safe: reads only the values passed in (server code passes process.env).

import type { Plan } from "./features";

export type PlanConfig = {
  /** Monthly price in pence, excluding VAT. PLACEHOLDER until set. */
  monthlyPricePence: number | null;
  /** SMS segments included per garage-local month. PLACEHOLDER until set. */
  smsAllowance: number | null;
  /** AI front desk minutes included per month (Pro only; Essentials has no AI front desk). PLACEHOLDER until set. */
  aiMinutesAllowance: number | null;
};

export type PlansConfig = Record<Plan, PlanConfig> & {
  /** Monthly price of each site beyond the first (multi-site, Pro). PLACEHOLDER until set. */
  extraSitePricePence: number | null;
  /** Length of the Pro trial for new garages, in calendar months (D25: one month, as a new company). The
   *  database default matches (garages.trial_ends_at = now() + interval '1 month'). */
  trialMonths: number;
};

/** The env vars that set each placeholder (server only; none is NEXT_PUBLIC_). */
export const PLAN_CONFIG_ENV = {
  essentialsPrice: "PLAN_ESSENTIALS_PRICE_PENCE",
  proPrice: "PLAN_PRO_PRICE_PENCE",
  essentialsSms: "PLAN_ESSENTIALS_SMS_ALLOWANCE",
  proSms: "PLAN_PRO_SMS_ALLOWANCE",
  proAiMinutes: "PLAN_PRO_AI_MINUTES",
  extraSitePrice: "PLAN_EXTRA_SITE_PRICE_PENCE",
} as const;

type Env = Record<string, string | undefined>;

function wholeNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function getPlansConfig(env: Env = {}): PlansConfig {
  return {
    essentials: {
      monthlyPricePence: wholeNumber(env[PLAN_CONFIG_ENV.essentialsPrice]), // PLACEHOLDER
      smsAllowance: wholeNumber(env[PLAN_CONFIG_ENV.essentialsSms]), // PLACEHOLDER
      aiMinutesAllowance: 0, // Essentials has no AI front desk (D17)
    },
    pro: {
      monthlyPricePence: wholeNumber(env[PLAN_CONFIG_ENV.proPrice]), // PLACEHOLDER
      smsAllowance: wholeNumber(env[PLAN_CONFIG_ENV.proSms]), // PLACEHOLDER
      aiMinutesAllowance: wholeNumber(env[PLAN_CONFIG_ENV.proAiMinutes]), // PLACEHOLDER
    },
    extraSitePricePence: wholeNumber(env[PLAN_CONFIG_ENV.extraSitePrice]), // PLACEHOLDER
    trialMonths: 1,
  };
}

/** "one month", "2 months": the trial length in copy. */
export function formatTrialLength(months: number): string {
  return months === 1 ? "one month" : `${months} months`;
}

export type UsageMetric = "sms_segments" | "ai_minutes";

export function allowanceFor(config: PlansConfig, plan: Plan, metric: UsageMetric): number | null {
  return metric === "sms_segments" ? config[plan].smsAllowance : config[plan].aiMinutesAllowance;
}

/** "£49 a month", or "Price to be confirmed" while the placeholder is unset. */
export function formatPlanPrice(pence: number | null): string {
  if (pence === null) return "Price to be confirmed";
  const pounds = pence / 100;
  return `£${Number.isInteger(pounds) ? pounds : pounds.toFixed(2)} a month`;
}
