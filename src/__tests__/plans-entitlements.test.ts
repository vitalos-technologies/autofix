import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowanceFor, formatPlanPrice, formatTrialLength, getPlansConfig } from "@/lib/plans/config";
import {
  effectivePlan,
  hasFeature,
  isOnTrial,
  isPlanRequiredDatabaseError,
  PlanRequiredError,
  planLabel,
  planRequiredBody,
  trialDaysLeft,
} from "@/lib/plans/entitlements";
import { ESSENTIALS_FEATURES, FEATURES, PRO_FEATURES, proFeatureForPath } from "@/lib/plans/features";
import { usageLine } from "@/lib/plans/usage";

const NOW = new Date("2026-10-28T12:00:00Z");
const trial = { plan: "pro", trialEndsAt: "2026-11-05T09:00:00Z", planChosen: null };
const expired = { plan: "pro", trialEndsAt: "2026-10-27T12:00:00Z", planChosen: null };
const expiredChosePro = { plan: "pro", trialEndsAt: "2026-10-27T12:00:00Z", planChosen: "pro" };
const essentials = { plan: "essentials", trialEndsAt: null, planChosen: "essentials" };
const paidPro = { plan: "pro", trialEndsAt: null, planChosen: "pro" };

describe("plans: one map from feature to plan (D17)", () => {
  it("keeps everything Pitline did before Phase 5 on Essentials, except the AI front desk", () => {
    for (const feature of ["booking_page", "custom_domain", "vehicle_lookup", "approvals", "diary", "customers", "import", "reminders",
      "review_requests", "missed_calls", "inbox", "invoices", "team", "askbridge", "basic_reports", "sms_allowance"] as const) {
      expect(FEATURES[feature].plan, feature).toBe("essentials");
    }
    expect(FEATURES.ai_front_desk.plan).toBe("pro");
  });

  it("puts the eleven Pro lines from D17 on Pro", () => {
    expect([...PRO_FEATURES].sort()).toEqual([
      "accounting_sync", "advanced_reports", "ai_front_desk", "campaigns", "courtesy_cars", "fleet_accounts", "health_checks",
      "multi_site", "payments", "priority_support", "service_plans",
    ]);
  });

  it("matches plan_feature_plan() in the migration feature for feature", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261029000100_plans.sql"), "utf8");
    const body = sql.slice(sql.indexOf("create function public.plan_feature_plan"), sql.indexOf("comment on function public.plan_feature_plan"));
    const essentialsBlock = body.slice(body.indexOf("case p_feature"), body.indexOf("return 'essentials'"));
    const proBlock = body.slice(body.indexOf("return 'essentials'") + "return 'essentials'".length, body.indexOf("return 'pro'"));
    const names = (block: string) => [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
    expect(names(essentialsBlock)).toEqual([...ESSENTIALS_FEATURES].sort());
    expect(names(proBlock)).toEqual([...PRO_FEATURES].sort());
  });

  it("knows which Pro section a path belongs to", () => {
    expect(proFeatureForPath("/app/campaigns")).toBe("campaigns");
    expect(proFeatureForPath("/app/campaigns/new")).toBe("campaigns");
    expect(proFeatureForPath("/app/campaignsx")).toBeNull();
    expect(proFeatureForPath("/app/bookings")).toBeNull();
  });
});

describe("plans: entitlements", () => {
  it("gives a running trial Pro and says how long is left", () => {
    expect(effectivePlan(trial, NOW)).toBe("pro");
    expect(isOnTrial(trial, NOW)).toBe(true);
    expect(trialDaysLeft(trial, NOW)).toBe(8);
    expect(planLabel(trial, NOW)).toBe("Pro trial · 8 days left");
    expect(trialDaysLeft({ ...trial, trialEndsAt: "2026-10-28T13:00:00Z" }, NOW)).toBe(1);
    expect(planLabel({ ...trial, trialEndsAt: "2026-10-28T13:00:00Z" }, NOW)).toBe("Pro trial · 1 day left");
  });

  it("treats an expired, unchosen trial as Essentials at once (before the expiry job)", () => {
    expect(effectivePlan(expired, NOW)).toBe("essentials");
    expect(hasFeature(expired, "campaigns", NOW)).toBe(false);
    expect(hasFeature(expired, "reminders", NOW)).toBe(true);
    expect(planLabel(expired, NOW)).toBe("Essentials");
  });

  it("keeps Pro when the garage chose it before the trial ended", () => {
    expect(effectivePlan(expiredChosePro, NOW)).toBe("pro");
    expect(hasFeature(expiredChosePro, "payments", NOW)).toBe(true);
  });

  it("gates every Pro feature for Essentials and none for Pro", () => {
    for (const feature of PRO_FEATURES) {
      expect(hasFeature(essentials, feature, NOW)).toBe(false);
      expect(hasFeature(paidPro, feature, NOW)).toBe(true);
    }
    for (const feature of ESSENTIALS_FEATURES) expect(hasFeature(essentials, feature, NOW)).toBe(true);
  });

  it("treats unknown or old plan values as Essentials", () => {
    expect(effectivePlan({ plan: "growth", trialEndsAt: null, planChosen: null }, NOW)).toBe("essentials");
    expect(effectivePlan({ plan: "front_desk", trialEndsAt: null, planChosen: null }, NOW)).toBe("essentials");
    expect(effectivePlan({ plan: undefined, trialEndsAt: undefined, planChosen: undefined }, NOW)).toBe("essentials");
  });

  it("answers Pro-only work with a 403 PLAN_REQUIRED and a reason", () => {
    const error = new PlanRequiredError("campaigns");
    expect(error.status).toBe(403);
    expect(error.code).toBe("PLAN_REQUIRED");
    expect(planRequiredBody("campaigns")).toEqual({
      code: "PLAN_REQUIRED",
      feature: "campaigns",
      plan: "pro",
      message: "Campaigns is part of Pitline Pro. The garage owner can upgrade in Settings, Plan.",
    });
    expect(isPlanRequiredDatabaseError({ code: "P0001", message: "PLAN_REQUIRED: campaigns" })).toBe(true);
    expect(isPlanRequiredDatabaseError({ code: "42501", message: "new row violates row-level security policy" })).toBe(false);
  });
});

describe("plans: prices and allowances are placeholders until Temitope sets them", () => {
  it("leaves every price and allowance unset by default", () => {
    const config = getPlansConfig({});
    expect(config.essentials.monthlyPricePence).toBeNull();
    expect(config.pro.monthlyPricePence).toBeNull();
    expect(config.essentials.smsAllowance).toBeNull();
    expect(config.pro.smsAllowance).toBeNull();
    expect(config.pro.aiMinutesAllowance).toBeNull();
    expect(config.extraSitePricePence).toBeNull();
    expect(config.essentials.aiMinutesAllowance).toBe(0);
    expect(config.trialMonths).toBe(1);
    expect(formatTrialLength(config.trialMonths)).toBe("one month");
    expect(formatTrialLength(2)).toBe("2 months");
    expect(formatPlanPrice(null)).toBe("Price to be confirmed");
  });

  it("reads them from server env vars when set, ignoring nonsense", () => {
    const config = getPlansConfig({ PLAN_PRO_PRICE_PENCE: "4900", PLAN_ESSENTIALS_SMS_ALLOWANCE: "250", PLAN_PRO_SMS_ALLOWANCE: "-3", PLAN_PRO_AI_MINUTES: "1.5" });
    expect(config.pro.monthlyPricePence).toBe(4900);
    expect(formatPlanPrice(4900)).toBe("£49 a month");
    expect(formatPlanPrice(4950)).toBe("£49.50 a month");
    expect(allowanceFor(config, "essentials", "sms_segments")).toBe(250);
    expect(allowanceFor(config, "pro", "sms_segments")).toBeNull();
    expect(allowanceFor(config, "pro", "ai_minutes")).toBeNull();
  });

  it("works out the meter and the overage, never a block", () => {
    expect(usageLine("sms_segments", 120, null)).toEqual({ metric: "sms_segments", used: 120, allowance: null, overage: null, percent: null });
    expect(usageLine("sms_segments", 120, 100)).toEqual({ metric: "sms_segments", used: 120, allowance: 100, overage: 20, percent: 100 });
    expect(usageLine("sms_segments", 25, 100).percent).toBe(25);
    expect(usageLine("ai_minutes", 0, 0).percent).toBe(0);
  });
});
