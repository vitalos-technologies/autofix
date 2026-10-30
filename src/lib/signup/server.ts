import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { GARAGE_COOKIE, GARAGE_COOKIE_OPTIONS } from "@/lib/tenancy/admin";
import { clearHostCache } from "@/lib/tenancy/resolve";
import { garageBaseUrl, type GarageUrlSubject, type UrlEnvironment } from "@/lib/tenancy/urls";
import { billingSelfServe, getBillingReadiness } from "@/lib/billing";
import type { Plan } from "@/lib/plans/features";
import { createGaragePayload, type GarageInput } from "./schema";
import { verifyTurnstile } from "@/lib/turnstile";
import { slugProblem } from "./slug";

// Server side of sign-up (P4.4). The garage is created by `create_garage(p_user_id, p_garage)`
// with the service role, for the user of the current session only; the user id never comes from
// a form. Everything else in the wizard runs with the new owner's own RLS client.

export type SignupSession = { user: User; confirmed: boolean; client: SupabaseClient };

/** The signed-in user (confirmed or not), or null. */
export async function getSignupSession(): Promise<SignupSession | null> {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  return { user, confirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at), client };
}

export type SlugAvailability = { status: "available" | "taken" | "invalid" | "unavailable" };

/** Whether a slug can be claimed right now (format, reserved list, then `garages.slug`). */
export async function checkSlugAvailability(slug: string, service: SupabaseClient | null = createAdminClient()): Promise<SlugAvailability> {
  if (slugProblem(slug)) return { status: "invalid" };
  if (!service) return { status: "unavailable" };
  const { data, error } = await service.from("garages").select("id").eq("slug", slug).maybeSingle();
  if (error) return { status: "unavailable" };
  return { status: data ? "taken" : "available" };
}

/**
 * Which of `slugs` can be claimed right now, in one query (same rules as `checkSlugAvailability`),
 * in the order given. Null when the lookup cannot be made.
 */
export async function availableSlugs(slugs: string[], service: SupabaseClient | null = createAdminClient()): Promise<string[] | null> {
  const candidates = [...new Set(slugs)].filter((slug) => !slugProblem(slug));
  if (!candidates.length) return [];
  if (!service) return null;
  const { data, error } = await service.from("garages").select("slug").in("slug", candidates);
  if (error) return null;
  const taken = new Set((data ?? []).map((row: { slug: string }) => row.slug));
  return candidates.filter((slug) => !taken.has(slug));
}

export type CreateGarageResult =
  | { ok: true; garageId: string; slug: string }
  | { ok: false; code: "SLUG_TAKEN" | "SLUG_RESERVED" | "EMAIL_NOT_CONFIRMED" | "GARAGE_LIMIT_REACHED" | "INVALID_GARAGE" | "UNAVAILABLE"; field?: string };

const KNOWN_CODES = ["SLUG_TAKEN", "SLUG_RESERVED", "EMAIL_NOT_CONFIRMED", "GARAGE_LIMIT_REACHED", "INVALID_GARAGE"] as const;

/** Maps a `create_garage()` error to a code (and field for INVALID_GARAGE). Never returns the database's text. */
export function createGarageError(message: string | null | undefined): Extract<CreateGarageResult, { ok: false }> {
  const text = message ?? "";
  const code = KNOWN_CODES.find((candidate) => text.startsWith(candidate));
  if (!code) return { ok: false, code: "UNAVAILABLE" };
  if (code === "INVALID_GARAGE") {
    const field = /^INVALID_GARAGE: ([a-z_]+)/.exec(text)?.[1];
    return { ok: false, code, ...(field ? { field } : {}) };
  }
  return { ok: false, code };
}

/**
 * Creates the garage for `user` and selects it (`af_garage`), so the owner lands in it.
 * Also stores the owner's display name as their admin profile, and the plan they chose (D26): one
 * month free on it (the trial_ends_at default). `plan_chosen` stays empty until billing confirms it,
 * so an unpaid Pro month still ends on Essentials. With Stripe billing on, the garage is card first.
 */
export async function createGarageForUser(user: User, input: GarageInput, displayName: string | null, plan: Plan = "pro"): Promise<CreateGarageResult> {
  const service = createAdminClient();
  if (!service) return { ok: false, code: "UNAVAILABLE" };
  const { data, error } = await service.rpc("create_garage", { p_user_id: user.id, p_garage: createGaragePayload(input) });
  if (error) return createGarageError(error.message);
  const result = data as { garage_id?: string; slug?: string } | null;
  if (!result?.garage_id) return { ok: false, code: "UNAVAILABLE" };
  const cardRequired = billingSelfServe(getBillingReadiness());
  if (plan !== "pro" || cardRequired) {
    const { error: planError } = await service.from("garages").update({ plan, card_required: cardRequired }).eq("id", result.garage_id);
    if (planError) return { ok: false, code: "UNAVAILABLE" };
  }

  const name = displayName?.trim();
  if (name) {
    // Best effort: the profile only names the owner in the admin (falls back to the email).
    await service.from("admin_profiles").upsert({ user_id: user.id, display_name: name.slice(0, 100) }, { onConflict: "user_id", ignoreDuplicates: true });
  }
  (await cookies()).set(GARAGE_COOKIE, result.garage_id, GARAGE_COOKIE_OPTIONS);
  // A visit to the free link before the garage existed may have cached a miss.
  clearHostCache();
  return { ok: true, garageId: result.garage_id, slug: result.slug ?? input.slug };
}

/** The display name the owner gave at sign-up (`user_metadata.display_name`). */
export function signupDisplayName(user: User): string | null {
  const value = user.user_metadata?.display_name;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null;
}

/** The caller's IP for rate limits (first x-forwarded-for hop), or "unknown". */
export async function requestIp(): Promise<string> {
  const requestHeaders = await headers();
  return (requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}

/** Turnstile runs only when both keys are configured (as on the booking pages). */
export function signupHumanCheckConfigured(env: Readonly<Record<string, string | undefined>> = process.env) {
  return Boolean(env.TURNSTILE_SECRET_KEY?.trim() && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim());
}

export async function passSignupHumanCheck(token: FormDataEntryValue | null, ip: string) {
  if (!signupHumanCheckConfigured()) return true;
  const value = typeof token === "string" ? token.trim() : "";
  return Boolean(value) && verifyTurnstile(value, ip === "unknown" ? undefined : ip);
}

/**
 * The garage's booking link for the wizard and the done screen: `garageBaseUrl()`, except that a
 * production build under Playwright (`PLAYWRIGHT_TEST=true`) links to the local `<slug>.localhost`
 * host the tests can open.
 */
export function onboardingBookingUrl(garage: GarageUrlSubject, env: UrlEnvironment = process.env): string {
  return garageBaseUrl(garage, env.PLAYWRIGHT_TEST === "true" ? { ...env, NODE_ENV: "development" } : env);
}
