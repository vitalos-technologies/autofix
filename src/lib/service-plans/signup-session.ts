import "server-only";

import { cookies } from "next/headers";
import { z } from "zod";
import { openValue, sealValue } from "@/lib/booking-engine/state";

// The service plan sign-up between /plans/<plan> and /plans/confirm (P5.11): which subscription this
// browser is setting up, sealed with AES-256-GCM for this garage like the booking draft (`af_booking`),
// httpOnly, path /plans, 2 hours. The address bar only ever holds /plans/confirm: never a
// registration, phone number or subscription id.

export const PLAN_COOKIE = "af_plan";
export const PLAN_COOKIE_MAX_AGE_S = 2 * 60 * 60;

const payloadSchema = z.object({ subscriptionId: z.string().uuid() });

export function sealPlanSession(garageId: string, subscriptionId: string, now?: Date): string {
  return sealValue(PLAN_COOKIE, garageId, { subscriptionId }, { maxAgeS: PLAN_COOKIE_MAX_AGE_S, ...(now ? { now } : {}) });
}

export function openPlanSession(garageId: string, sealed: string | null | undefined, now?: Date): string | null {
  const parsed = payloadSchema.safeParse(openValue(PLAN_COOKIE, garageId, sealed, now ? { now } : {}));
  return parsed.success ? parsed.data.subscriptionId.toLowerCase() : null;
}

export async function writePlanSession(garageId: string, subscriptionId: string): Promise<void> {
  const store = await cookies();
  store.set(PLAN_COOKIE, sealPlanSession(garageId, subscriptionId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/plans",
    maxAge: PLAN_COOKIE_MAX_AGE_S,
  });
}

export async function readPlanSession(garageId: string): Promise<string | null> {
  const store = await cookies();
  return openPlanSession(garageId, store.get(PLAN_COOKIE)?.value);
}
