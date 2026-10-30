/**
 * Sign-up and onboarding validation (P4.4). Client-safe and pure: the wizard shows these messages
 * as the owner types, and the server actions run the same parsers before anything is written.
 */
import { normaliseUkPostcode } from "@/lib/booking-flow/copy";
import { toE164UK } from "@/lib/messaging/phone";
import { placeWebsite } from "@/lib/places/map";
import type { PlaceOpeningWindow } from "@/lib/places/types";
import { isPlaceId } from "@/lib/places/types";
import { normaliseSlugInput, SLUG_PROBLEM_MESSAGES, slugProblem } from "./slug";

export const PASSWORD_MIN_LENGTH = 12;

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>;
export type ParseResult<Value, Field extends string> = { ok: true; value: Value } | { ok: false; errors: FieldErrors<Field> };

function value(form: FormData | Record<string, unknown>, key: string): string {
  const raw = form instanceof FormData ? form.get(key) : form[key];
  return typeof raw === "string" ? raw : "";
}

// --- Account --------------------------------------------------------------

export type AccountField = "name" | "email" | "password";
export type AccountInput = { name: string; email: string; password: string };

/**
 * zod's email pattern (`z.email()`), copied: this module also runs in the browser, and importing zod
 * for one check added 64 KB gzipped to the sign-up pages. A test keeps it equal to zod's.
 */
export const EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/** Exactly `z.email().safeParse(value).success` for a string. */
function isEmail(value: string) {
  return EMAIL_PATTERN.test(value);
}

export function parseAccountForm(form: FormData | Record<string, unknown>): ParseResult<AccountInput, AccountField> {
  const name = value(form, "name").replace(/\s+/g, " ").trim();
  const email = value(form, "email").trim().toLowerCase();
  const password = value(form, "password");
  const errors: FieldErrors<AccountField> = {};
  if (name.length < 2 || name.length > 100) errors.name = "Enter your name.";
  if (!isEmail(email) || email.length > 254) errors.email = "Enter a valid email address, like name@garage.co.uk.";
  if (password.length < PASSWORD_MIN_LENGTH) errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  else if (password.length > 128) errors.password = "Use 128 characters or fewer.";
  else if (password.trim().length !== password.length) errors.password = "Your password can't start or end with a space.";
  else if (password.toLowerCase().includes(email.split("@")[0] ?? "\u0000") && (email.split("@")[0]?.length ?? 0) >= 4) {
    errors.password = "Don't use your email address in your password.";
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, email, password } };
}

// --- Garage details + booking link (the two steps before the garage exists) ---

export type GarageField = "name" | "phone" | "email" | "website" | "line1" | "line2" | "town" | "postcode" | "slug" | "placeId" | "openingHours";

export type GarageInput = {
  name: string;
  slug: string;
  /** E.164 */
  phone: string;
  email: string | null;
  website: string | null;
  address: { line1: string; line2: string; town: string; postcode: string };
  placeId: string | null;
  /** From Google, when the owner kept them; empty means the default hours. */
  openingHours: PlaceOpeningWindow[];
};

export type GarageDetailsInput = Omit<GarageInput, "slug" | "openingHours" | "placeId">;

export function parseGarageDetails(form: FormData | Record<string, unknown>): ParseResult<GarageDetailsInput, GarageField> {
  const name = value(form, "name").replace(/\s+/g, " ").trim();
  const phoneInput = value(form, "phone");
  const phone = toE164UK(phoneInput, { allowLandline: true });
  const emailInput = value(form, "email").trim().toLowerCase();
  const websiteInput = value(form, "website").trim();
  const website = websiteInput ? placeWebsite(/^https?:\/\//i.test(websiteInput) ? websiteInput : `https://${websiteInput}`) : null;
  const line1 = value(form, "line1").replace(/\s+/g, " ").trim();
  const line2 = value(form, "line2").replace(/\s+/g, " ").trim();
  const town = value(form, "town").replace(/\s+/g, " ").trim();
  const postcode = normaliseUkPostcode(value(form, "postcode"));

  const errors: FieldErrors<GarageField> = {};
  if (name.length < 2 || name.length > 120) errors.name = "Enter your garage's name.";
  if (!phone) errors.phone = "Enter a UK phone number customers can call, like 01302 123456.";
  if (emailInput && (!isEmail(emailInput) || emailInput.length > 254)) errors.email = "Enter a valid email address, or leave it empty.";
  if (websiteInput && !website) errors.website = "Enter a website address, like www.yourgarage.co.uk, or leave it empty.";
  if (!line1 || line1.length > 120) errors.line1 = "Enter the first line of the address.";
  if (line2.length > 120) errors.line2 = "Use 120 characters or fewer.";
  if (!town || town.length > 120) errors.town = "Enter the town or city.";
  if (!postcode) errors.postcode = "Enter a UK postcode, like DN4 5AB.";

  if (Object.keys(errors).length || !phone || !postcode) return { ok: false, errors };
  return {
    ok: true,
    value: { name, phone, email: emailInput || null, website, address: { line1, line2, town, postcode } },
  };
}

export function parseSlug(raw: string): ParseResult<string, "slug"> {
  const slug = normaliseSlugInput(raw);
  const problem = slugProblem(slug);
  return problem ? { ok: false, errors: { slug: SLUG_PROBLEM_MESSAGES[problem] } } : { ok: true, value: slug };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The opening hours the wizard carries as JSON (from Places); invalid or overlapping windows refuse the lot. */
export function parseOpeningHours(raw: string): PlaceOpeningWindow[] | null {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > 28) return null;
  const windows: PlaceOpeningWindow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return null;
    const { weekday, opens, closes } = entry as Record<string, unknown>;
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
    if (typeof opens !== "string" || typeof closes !== "string" || !TIME.test(opens) || !TIME.test(closes) || closes <= opens) return null;
    if (windows.some((window) => window.weekday === weekday && opens < window.closes && window.opens < closes)) return null;
    windows.push({ weekday, opens, closes });
  }
  return windows;
}

/** Everything `create_garage()` needs, from the wizard's final form post. */
export function parseGarageForm(form: FormData | Record<string, unknown>): ParseResult<GarageInput, GarageField> {
  const details = parseGarageDetails(form);
  const slug = parseSlug(value(form, "slug"));
  const placeIdRaw = value(form, "placeId").trim();
  const placeId = placeIdRaw && isPlaceId(placeIdRaw) ? placeIdRaw : null;
  const openingHours = value(form, "useOpeningHours") === "yes" ? parseOpeningHours(value(form, "openingHours")) : [];

  const errors: FieldErrors<GarageField> = { ...(details.ok ? {} : details.errors), ...(slug.ok ? {} : slug.errors) };
  if (placeIdRaw && !placeId) errors.placeId = "Pick your garage again.";
  if (openingHours === null) errors.openingHours = "The opening hours from Google can't be used. Untick them and set your hours later.";
  if (!details.ok || !slug.ok || openingHours === null || Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { ...details.value, slug: slug.value, placeId, openingHours } };
}

/** The plan chosen at sign-up (D26); anything else is Pro, the default. */
export function parseSignupPlan(raw: FormDataEntryValue | null | undefined): "essentials" | "pro" {
  return raw === "essentials" ? "essentials" : "pro";
}

/** `create_garage()`'s jsonb payload. */
export function createGaragePayload(input: GarageInput) {
  return {
    name: input.name,
    slug: input.slug,
    phone: input.phone,
    email: input.email,
    website: input.website,
    google_place_id: input.placeId,
    address: input.address,
    opening_hours: input.openingHours,
  };
}

// --- Invites --------------------------------------------------------------

export const INVITE_ROLES = ["manager", "technician", "front_desk"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const ROLE_LABELS: Record<"owner" | InviteRole, string> = {
  owner: "Owner",
  manager: "Manager",
  technician: "Technician",
  front_desk: "Front desk",
};

export const ROLE_DESCRIPTIONS: Record<"owner" | InviteRole, string> = {
  owner: "Everything, including billing, branding, MOT and the team.",
  manager: "Services, hours, bays, customers and invites.",
  technician: "Sees the diary and bookings, updates job status and notes.",
  front_desk: "Sees the diary and bookings, updates booking status and notes.",
};

export type InviteField = "email" | "role";
export type InviteInput = { email: string; role: InviteRole };

export function parseInviteForm(form: FormData | Record<string, unknown>): ParseResult<InviteInput, InviteField> {
  const email = value(form, "email").trim().toLowerCase();
  const role = value(form, "role");
  const errors: FieldErrors<InviteField> = {};
  if (!isEmail(email) || email.length > 254) errors.email = "Enter their email address.";
  if (!(INVITE_ROLES as readonly string[]).includes(role)) errors.role = "Choose a role.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { email, role: role as InviteRole } };
}
