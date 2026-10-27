/**
 * Customer-facing wording and formatting for the booking flow. Pure and client-safe.
 */
import { REMINDER_CONSENT_COPY, REMINDER_CONSENT_COPY_NO_MOT } from "@/components/book/consent-checkbox";
import type { CustomerChannel, LocationMode } from "@/lib/booking-engine/types";

/** Symptom chips on the service step. Values are stored as `bookings.symptoms`. */
export const SYMPTOM_OPTIONS = [
  { value: "Warning light", label: "Warning light" },
  { value: "Odd noise", label: "Odd noise" },
] as const;

export const SYMPTOM_VALUES: readonly string[] = SYMPTOM_OPTIONS.map((option) => option.value);

export const NOTE_MAX_LENGTH = 500;

export const LOCATION_LABELS: Record<LocationMode, string> = {
  workshop: "Workshop",
  mobile: "Mobile visit",
};

export const CHANNEL_OPTIONS: ReadonlyArray<{ value: CustomerChannel; label: string }> = [
  { value: "sms", label: "Text" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
];

/** The reminder consent wording shown for this garage. The same text is stored with the consent. */
export function reminderConsentCopy(motEnabled: boolean): string {
  return motEnabled ? REMINDER_CONSENT_COPY : REMINDER_CONSENT_COPY_NO_MOT;
}

const UK_POSTCODE = /^(GIR ?0AA|[A-PR-UWYZ](?:[0-9][0-9A-HJKPSTUW]?|[A-HK-Y][0-9][0-9ABEHMNPRV-Y]?) ?[0-9][ABD-HJLNP-UW-Z]{2})$/;

/** `dn12ab` → `DN1 2AB`; null when it is not a UK postcode. */
export function normaliseUkPostcode(value: string | null | undefined): string | null {
  const compact = (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length < 5 || compact.length > 7) return null;
  const spaced = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return UK_POSTCODE.test(spaced) ? spaced : null;
}

/** The outward code (`DN1` from `DN1 2AB`); the whole value when it has no space. */
export function postcodeDistrict(postcode: string | null | undefined): string {
  const value = (postcode ?? "").trim().toUpperCase();
  return value.includes(" ") ? (value.split(" ")[0] ?? "") : value;
}

/**
 * Whether a postcode is inside the garage's mobile service area (`garages.service_area`: postcode
 * districts such as `DN1`, `S6`). Same rule as `create_booking()`: the district must be listed
 * exactly, and an empty list means the garage offers no mobile visits.
 */
export function inServiceArea(postcode: string, serviceArea: readonly string[]): boolean {
  const district = postcodeDistrict(postcode);
  return Boolean(district) && serviceArea.some((area) => area.trim().toUpperCase().replace(/\s+/g, "") === district);
}

/** "Workshop, DN4" / "Mobile visit, DN1" for the confirmation card. */
export function whereLabel(mode: LocationMode, customerPostcode: string | null | undefined, garagePostcode: string | null | undefined) {
  const district = postcodeDistrict(mode === "mobile" ? customerPostcode : garagePostcode);
  return district ? `${LOCATION_LABELS[mode]}, ${district}` : LOCATION_LABELS[mode];
}

/** `+447700900412` → `07••• •••412` (shown on the confirmation page; never the full number). */
export function maskMobile(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const national = digits.startsWith("44") ? `0${digits.slice(2)}` : digits;
  if (national.length < 6) return "•••";
  return `${national.slice(0, 2)}••• •••${national.slice(-3)}`;
}

/** `sarah@example.com` → `s•••@example.com`. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "•••";
  return `${local.charAt(0)}•••@${domain}`;
}

/** Last three digits of a phone number, for screen readers instead of the bullets. */
export function lastDigits(value: string, count = 3) {
  return value.replace(/\D/g, "").slice(-count);
}
