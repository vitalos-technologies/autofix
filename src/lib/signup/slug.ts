/**
 * Booking-link slug rules for sign-up (P4.4). Client-safe and pure.
 * The rules are `isValidSlug` / `RESERVED_SLUGS` from the tenancy hosts module;
 * the database repeats them in `create_garage()` and `reserved_garage_slugs()`.
 */
import { isValidSlug, RESERVED_SLUGS } from "@/lib/tenancy/hosts";

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;

export type SlugProblem = "empty" | "too_short" | "too_long" | "characters" | "hyphens" | "reserved";

export const SLUG_PROBLEM_MESSAGES: Record<SlugProblem | "taken" | "unavailable", string> = {
  empty: "Choose a booking link.",
  too_short: `Use at least ${SLUG_MIN_LENGTH} characters.`,
  too_long: `Use ${SLUG_MAX_LENGTH} characters or fewer.`,
  characters: "Use lower-case letters, numbers and hyphens only.",
  hyphens: "Start and end with a letter or number, with no double hyphens.",
  reserved: "That link is reserved. Try another.",
  taken: "Another garage already uses that link. Try another.",
  unavailable: "We couldn't check that link just now. Try again.",
};

/** Turns a garage name into a slug candidate: "Kingsway Autocare & MOT" → "kingsway-autocare-mot". */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Lower-cases and trims what the owner typed, without changing anything else. */
export function normaliseSlugInput(value: string): string {
  return value.trim().toLowerCase();
}

/** Why a slug cannot be used, or null when the format is fine (it may still be taken). */
export function slugProblem(slug: string): SlugProblem | null {
  if (!slug) return "empty";
  if (slug.length < SLUG_MIN_LENGTH) return "too_short";
  if (slug.length > SLUG_MAX_LENGTH) return "too_long";
  if (!/^[a-z0-9-]+$/.test(slug)) return "characters";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  if (!isValidSlug(slug)) return "hyphens";
  return null;
}

/**
 * Alternatives to offer when a slug is taken: the town, then numbers.
 * Only well-formed, unreserved slugs are returned.
 */
export function slugAlternatives(slug: string, town?: string | null): string[] {
  const base = slug.slice(0, SLUG_MAX_LENGTH - 3).replace(/-+$/g, "");
  const townPart = town ? slugify(town) : "";
  const candidates = [
    townPart ? `${base}-${townPart}`.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "") : "",
    `${base}-2`,
    `${base}-3`,
  ];
  return [...new Set(candidates)].filter((candidate) => candidate && candidate !== slug && slugProblem(candidate) === null);
}
