import "server-only";

import { NextResponse } from "next/server";
import type { Garage } from "@/lib/tenancy/garage";
import type { AdminContext } from "@/lib/tenancy/admin";
import { effectivePlan, hasFeature, PlanRequiredError, planRequiredBody, planRequiredMessage } from "./entitlements";
import type { Feature, Plan } from "./features";

// Server-side plan checks (P5.2). The garage always comes from the request host (public pages and
// the agent API) or the member's selected garage (admin), never from request data. The UI only
// follows these: a hidden button is never the check. RLS write policies on Pro tables apply the
// same rule in SQL (garage_has_feature()).

type PlanGarage = Pick<Garage, "plan" | "trialEndsAt" | "planChosen">;

function stateOf(garage: PlanGarage) {
  return { plan: garage.plan, trialEndsAt: garage.trialEndsAt ?? null, planChosen: garage.planChosen ?? null };
}

export function garagePlan(garage: PlanGarage, now: Date = new Date()): Plan {
  return effectivePlan(stateOf(garage), now);
}

export function garageHasFeature(garage: PlanGarage, feature: Feature, now: Date = new Date()): boolean {
  return hasFeature(stateOf(garage), feature, now);
}

/** Throws PlanRequiredError (403, `PLAN_REQUIRED`) unless the garage's plan includes the feature. */
export function requireFeature(garage: PlanGarage, feature: Feature, now: Date = new Date()): void {
  if (!garageHasFeature(garage, feature, now)) throw new PlanRequiredError(feature);
}

/** For server actions: the admin's selected garage must have the feature. */
export function requireAdminFeature(admin: Pick<AdminContext, "garage">, feature: Feature): void {
  requireFeature(admin.garage, feature);
}

/** For server actions that return form state: null when allowed, else the plain-English reason. */
export function featureProblem(admin: Pick<AdminContext, "garage">, feature: Feature): string | null {
  return garageHasFeature(admin.garage, feature) ? null : planRequiredMessage(feature);
}

/** The 403 for `/api/admin/*` and other JSON routes: `{code: "PLAN_REQUIRED", feature, plan, message}`. */
export function planRequiredResponse(feature: Feature): NextResponse {
  return NextResponse.json(planRequiredBody(feature), { status: 403, headers: { "Cache-Control": "no-store" } });
}

/** Route-handler guard: null when allowed, else the 403 to return. */
export function featureGuard(garage: PlanGarage, feature: Feature): NextResponse | null {
  return garageHasFeature(garage, feature) ? null : planRequiredResponse(feature);
}
