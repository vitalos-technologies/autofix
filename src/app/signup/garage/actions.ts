"use server";

import { redirect } from "next/navigation";
import { getPlacesProvider, cleanPlacesQuery } from "@/lib/places/provider";
import { isPlaceId, PlacesLookupError, type PlaceDetails, type PlaceSummary } from "@/lib/places/types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { parseGarageForm, parseSignupPlan, parseSlug, type FieldErrors, type GarageField } from "@/lib/signup/schema";
import { availableSlugs, createGarageForUser, getSignupSession, requestIp, signupDisplayName } from "@/lib/signup/server";
import { SLUG_PROBLEM_MESSAGES, slugAlternatives } from "@/lib/signup/slug";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";

// Sign-up steps 1 and 2 (/signup/garage). Every action needs a signed-in user with a confirmed
// email; Places calls cost money, so they are rate limited per user. The garage is created only
// by createGarageAction, for the session's user.

const PLACES_MESSAGES: Record<PlacesLookupError["code"] | "limited" | "signed_out", string> = {
  not_configured: "Search isn't available. Enter your details below.",
  invalid_request: "Try a different search, like your garage's name and town.",
  not_found: "We couldn't load that garage. Pick it again or enter your details below.",
  rate_limited: "Search is busy. Wait a moment, or enter your details below.",
  unavailable: "Search isn't working just now. Enter your details below.",
  limited: "That's a lot of searches. Enter your details below, or wait a few minutes.",
  signed_out: "Your session has ended. Sign in again to carry on.",
};

async function confirmedUser() {
  const session = await getSignupSession();
  return session?.confirmed ? session.user : null;
}

export type PlacesSearchResult = { ok: true; results: PlaceSummary[] } | { ok: false; message: string };

export async function searchPlacesAction(query: string): Promise<PlacesSearchResult> {
  const user = await confirmedUser();
  if (!user) return { ok: false, message: PLACES_MESSAGES.signed_out };
  const cleaned = cleanPlacesQuery(query);
  if (!cleaned) return { ok: false, message: "Type at least three letters of your garage's name." };
  const provider = getPlacesProvider();
  if (!provider) return { ok: false, message: PLACES_MESSAGES.not_configured };
  if (!(await consumeRateLimit(user.id, "signup_places", 30, 600))) return { ok: false, message: PLACES_MESSAGES.limited };
  try {
    return { ok: true, results: await provider.search(cleaned) };
  } catch (error) {
    return { ok: false, message: PLACES_MESSAGES[error instanceof PlacesLookupError ? error.code : "unavailable"] };
  }
}

export type PlaceDetailsResult = { ok: true; place: PlaceDetails } | { ok: false; message: string };

export async function placeDetailsAction(placeId: string): Promise<PlaceDetailsResult> {
  const user = await confirmedUser();
  if (!user) return { ok: false, message: PLACES_MESSAGES.signed_out };
  if (!isPlaceId(placeId)) return { ok: false, message: PLACES_MESSAGES.not_found };
  const provider = getPlacesProvider();
  if (!provider) return { ok: false, message: PLACES_MESSAGES.not_configured };
  if (!(await consumeRateLimit(user.id, "signup_places", 30, 600))) return { ok: false, message: PLACES_MESSAGES.limited };
  try {
    return { ok: true, place: await provider.details(placeId) };
  } catch (error) {
    return { ok: false, message: PLACES_MESSAGES[error instanceof PlacesLookupError ? error.code : "unavailable"] };
  }
}

export type SlugCheckResult = { slug: string; status: "available" | "taken" | "invalid" | "unavailable"; message: string; alternatives: string[] };

export async function checkSlugAction(raw: string, town?: string): Promise<SlugCheckResult> {
  const parsed = parseSlug(raw);
  if (!parsed.ok) return { slug: raw, status: "invalid", message: parsed.errors.slug ?? SLUG_PROBLEM_MESSAGES.characters, alternatives: [] };
  const user = await confirmedUser();
  if (!user || !(await consumeRateLimit(user.id, "signup_slug", 120, 600))) {
    return { slug: parsed.value, status: "unavailable", message: SLUG_PROBLEM_MESSAGES.unavailable, alternatives: [] };
  }
  // The link and the alternatives offered when it is taken, in one lookup.
  const free = await availableSlugs([parsed.value, ...slugAlternatives(parsed.value, town)]);
  if (!free) return { slug: parsed.value, status: "unavailable", message: SLUG_PROBLEM_MESSAGES.unavailable, alternatives: [] };
  if (free.includes(parsed.value)) return { slug: parsed.value, status: "available", message: "This link is free.", alternatives: [] };
  return { slug: parsed.value, status: "taken", message: SLUG_PROBLEM_MESSAGES.taken, alternatives: free.slice(0, 3) };
}

export type CreateGarageState = { seq: number; errors: FieldErrors<GarageField>; message?: string };

const CREATE_MESSAGES = {
  SLUG_TAKEN: "Another garage took that link a moment ago. Choose another.",
  SLUG_RESERVED: SLUG_PROBLEM_MESSAGES.reserved,
  EMAIL_NOT_CONFIRMED: "Confirm your email address first: use the link we sent you.",
  GARAGE_LIMIT_REACHED: "You've set up three garages today. Try again tomorrow, or contact Vitalos.",
  INVALID_GARAGE: "Some details can't be saved. Check them and try again.",
  UNAVAILABLE: "Your garage could not be created just now. Try again.",
} as const;

/** Steps 1 + 2 submit together: creates the garage (status onboarding), then on to security. */
export async function createGarageAction(previous: CreateGarageState, formData: FormData): Promise<CreateGarageState> {
  const seq = previous.seq + 1;
  const session = await getSignupSession();
  if (!session) redirect("/signup/garage");
  if (!session.confirmed) return { seq, errors: {}, message: CREATE_MESSAGES.EMAIL_NOT_CONFIRMED };
  const parsed = parseGarageForm(formData);
  if (!parsed.ok) return { seq, errors: parsed.errors };
  const ip = await requestIp();
  if (!(await consumeRateLimit(ip, "signup_garage_ip", 10, 3_600))) {
    return { seq, errors: {}, message: "Too many garages set up from here. Wait an hour and try again." };
  }

  const result = await createGarageForUser(session.user, parsed.value, signupDisplayName(session.user), parseSignupPlan(formData.get("plan")));
  if (!result.ok) {
    const errors: FieldErrors<GarageField> = {};
    if (result.code === "SLUG_TAKEN" || result.code === "SLUG_RESERVED") errors.slug = CREATE_MESSAGES[result.code];
    if (result.code === "INVALID_GARAGE" && result.field) {
      const field = ({ name: "name", phone: "phone", email: "email", website: "website", address: "line1", opening_hours: "openingHours", slug: "slug" } as Record<string, GarageField>)[result.field];
      if (field) errors[field] = CREATE_MESSAGES.INVALID_GARAGE;
    }
    return { seq, errors, message: CREATE_MESSAGES[result.code] };
  }
  redirect(ONBOARDING_PATHS.security);
}
