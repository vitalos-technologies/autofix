// Entitlement rules with no I/O (client-safe). The database applies the same rules in
// garage_effective_plan() and garage_has_feature(); the server checks in ./server.ts call these
// with the garage loaded from the request host or the member's selected garage, never from a body.

import { FEATURES, isPlan, type Feature, type Plan } from "./features";

export type PlanState = {
  plan: string | null | undefined;
  trialEndsAt: string | null | undefined;
  planChosen: string | null | undefined;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** True while a Pro trial is running at `now`. */
export function isOnTrial(state: PlanState, now: Date = new Date()): boolean {
  const ends = time(state.trialEndsAt);
  return state.plan === "pro" && ends !== null && ends > now.getTime();
}

/**
 * The plan the garage may use at `now`: an expired trial the garage did not convert is already
 * Essentials, before the daily expiry job has run. Anything unknown counts as Essentials.
 */
export function effectivePlan(state: PlanState, now: Date = new Date()): Plan {
  if (!isPlan(state.plan)) return "essentials";
  const ends = time(state.trialEndsAt);
  if (state.plan === "pro" && ends !== null && ends <= now.getTime() && state.planChosen !== "pro") return "essentials";
  return state.plan;
}

export function hasFeature(state: PlanState, feature: Feature, now: Date = new Date()): boolean {
  return FEATURES[feature].plan === "essentials" || effectivePlan(state, now) === "pro";
}

/** Whole days left in the trial, rounded up (a trial ending later today is 1 day); 0 when not on trial. */
export function trialDaysLeft(state: PlanState, now: Date = new Date()): number {
  if (!isOnTrial(state, now)) return 0;
  return Math.max(1, Math.ceil(((time(state.trialEndsAt) as number) - now.getTime()) / DAY_MS));
}

/** The label under the garage name in the switcher: "Pro trial · 9 days left", "Pro", "Essentials". */
export function planLabel(state: PlanState, now: Date = new Date()): string {
  if (isOnTrial(state, now)) {
    const days = trialDaysLeft(state, now);
    return `Pro trial · ${days} ${days === 1 ? "day" : "days"} left`;
  }
  return effectivePlan(state, now) === "pro" ? "Pro" : "Essentials";
}

export class PlanRequiredError extends Error {
  readonly code = "PLAN_REQUIRED" as const;
  readonly status = 403 as const;
  constructor(readonly feature: Feature) {
    super(planRequiredMessage(feature));
    this.name = "PlanRequiredError";
  }
}

export function planRequiredMessage(feature: Feature): string {
  return `${FEATURES[feature].label} is part of Pitline Pro. The garage owner can upgrade in Settings, Plan.`;
}

/** The body of a 403 for Pro-only work: `{code: "PLAN_REQUIRED", feature, plan: "pro", message}`. */
export function planRequiredBody(feature: Feature) {
  return { code: "PLAN_REQUIRED" as const, feature, plan: "pro" as const, message: planRequiredMessage(feature) };
}

/** True for a PostgREST error raised by require_garage_feature() / a Pro write policy. */
export function isPlanRequiredDatabaseError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return Boolean(error && error.code === "P0001" && typeof error.message === "string" && error.message.startsWith("PLAN_REQUIRED"));
}
