// UK phone number normalisation and masking for messaging.
//
// Pure and client-safe (no env, no Node APIs). Numbers are stored in E.164
// (`+447700900123`). Tests and seed data use Ofcom's drama range
// (07700 900000 to 900999), which is never allocated to a real subscriber.

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

// UK mobiles: 071 to 075 and 077 to 079 are mobile; 07624 is the Isle of Man
// mobile range. 070 (personal numbers) and the rest of 076 (pagers) are not
// mobiles, so a text sent there would fail or cost more.
const UK_MOBILE_NATIONAL = /^7(?:[1-57-9]\d{8}|624\d{6})$/;

// Geographic (01, 02) and non-geographic (03) numbers: 9 or 10 digits after
// the trunk 0.
const UK_LANDLINE_NATIONAL = /^[123]\d{8,9}$/;

const ALLOWED_INPUT = /^[+\d\s().\-/]*$/;

export type ToE164UKOptions = {
  /** Also accept 01, 02 and 03 numbers (for call logs and garage numbers). Defaults to mobiles only. */
  allowLandline?: boolean;
};

/** True for any international number in E.164 form (`+` then 7 to 15 digits). */
export function isE164(value: string | null | undefined): value is string {
  return typeof value === "string" && E164_PATTERN.test(value);
}

/**
 * Normalises a UK number typed by a person or found in a CSV to E.164.
 *
 * Accepts `07700 900123`, `+44 7700 900123`, `+44 (0)7700 900123`,
 * `0044 7700 900123`, `447700900123`, `7700900123` (spreadsheet dropped the
 * leading zero) and an optional `whatsapp:` prefix. Returns `null` for
 * anything that is not a valid UK mobile (or landline when allowed).
 */
export function toE164UK(input: string | null | undefined, options: ToE164UKOptions = {}): string | null {
  if (typeof input !== "string") return null;

  let value = input.trim().replace(/^whatsapp:/i, "");
  // "+44 (0)7700 900123": the bracketed trunk zero is dropped in E.164.
  value = value.replace(/\(\s*0\s*\)/g, "");
  if (!value || !ALLOWED_INPUT.test(value)) return null;

  const hasPlus = value.trimStart().startsWith("+");
  const digitsWithPlus = value.replace(/[\s().\-/]/g, "");
  if (digitsWithPlus.lastIndexOf("+") > 0) return null;
  const digits = digitsWithPlus.replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;

  let national: string;
  if (hasPlus) {
    if (!digits.startsWith("44")) return null;
    national = digits.slice(2);
  } else if (digits.startsWith("0044")) {
    national = digits.slice(4);
  } else if (digits.startsWith("44") && digits.length >= 11 && digits.length <= 12) {
    national = digits.slice(2);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else if (/^7\d{9}$/.test(digits)) {
    national = digits;
  } else {
    return null;
  }

  // "+44 07700 900123" is a common mistake: drop the stray trunk zero.
  if (national.startsWith("0")) national = national.slice(1);

  if (UK_MOBILE_NATIONAL.test(national)) return `+44${national}`;
  if (options.allowLandline && UK_LANDLINE_NATIONAL.test(national)) return `+44${national}`;
  return null;
}

/** True when the value is a UK mobile in E.164 form. */
export function isUkMobileE164(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\+44/.test(value) && UK_MOBILE_NATIONAL.test(value.slice(3));
}

/**
 * Masks a phone number for logs and customer-facing pages:
 * `+447700900123` becomes `+44 7*** ***123`. Never returns more than the
 * first national digit and the last three digits.
 */
export function maskPhone(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) return "";

  const uk = toE164UK(value, { allowLandline: true });
  const normalised = uk ?? value.trim().replace(/^whatsapp:/i, "");
  const digits = normalised.replace(/\D/g, "");

  if (uk) {
    const national = uk.slice(3);
    return `+44 ${national.slice(0, 1)}*** ***${national.slice(-3)}`;
  }
  if (digits.length < 7) return "***";
  return `+${digits.slice(0, 2)}*** ***${digits.slice(-3)}`;
}
