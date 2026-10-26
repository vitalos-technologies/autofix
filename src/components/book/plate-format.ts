/**
 * Registration formatting for the plate input and plate chips. Display only: the server
 * normalises registrations (upper case, no spaces) before storing or looking them up.
 */

/** UK plates have at most 7 characters. */
export const MAX_PLATE_CHARACTERS = 7;

const CURRENT_FORMAT_TYPING = /^[A-Z]{2}[0-9]{2}[A-Z]{1,3}$/;
const CURRENT = /^([A-Z]{2}[0-9]{2})([A-Z]{3})$/;
const PREFIX = /^([A-Z][0-9]{1,3})([A-Z]{3})$/;
const SUFFIX = /^([A-Z]{3})([0-9]{1,3}[A-Z])$/;
const DATELESS_LETTERS_FIRST = /^([A-Z]{1,3})([0-9]{1,4})$/;
const DATELESS_NUMBERS_FIRST = /^([0-9]{1,4})([A-Z]{1,3})$/;

/** Upper case, letters and digits only: `ab12 cde` → `AB12CDE`. */
export function compactRegistration(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Formats what the customer is typing. Current-format plates (two letters, two numbers, three letters)
 * get the space added automatically (`ab12c` → `AB12 C`); other formats keep the customer's own single
 * spaces. Never more than seven characters.
 */
export function formatPlateInput(raw: string): string {
  const compact = compactRegistration(raw).slice(0, MAX_PLATE_CHARACTERS);
  if (CURRENT_FORMAT_TYPING.test(compact)) return `${compact.slice(0, 4)} ${compact.slice(4)}`;

  let kept = 0;
  let result = "";
  for (const character of raw.toUpperCase()) {
    if (/[A-Z0-9]/.test(character)) {
      if (kept === MAX_PLATE_CHARACTERS) break;
      result += character;
      kept += 1;
    } else if (/\s/.test(character) && result.length > 0 && !result.endsWith(" ") && !result.includes(" ")) {
      result += " ";
    }
  }
  return result;
}

/** Where the caret should go after formatting: after the same number of letters and digits. */
export function caretAfterFormatting(raw: string, caret: number, formatted: string): number {
  const significantBefore = compactRegistration(raw.slice(0, caret)).length;
  if (significantBefore === 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/[A-Z0-9]/.test(formatted.charAt(index))) seen += 1;
    if (seen === significantBefore) return index + 1;
  }
  return formatted.length;
}

/** A stored registration as it appears on a plate: `AB12CDE` → `AB12 CDE`, `A123BCD` → `A123 BCD`. */
export function formatRegistrationDisplay(registration: string): string {
  const compact = compactRegistration(registration);
  for (const pattern of [CURRENT, PREFIX, SUFFIX, DATELESS_LETTERS_FIRST, DATELESS_NUMBERS_FIRST]) {
    const match = pattern.exec(compact);
    if (match) return `${match[1]} ${match[2]}`;
  }
  return compact;
}
