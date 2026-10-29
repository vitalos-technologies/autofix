// Autofix's own phone line (DECISIONS A420). Pure.
//
// A number listed in AUTOFIX_PLATFORM_VOICE_NUMBERS (E.164, comma-separated)
// belongs to Autofix, not to a garage. The voice webhook answers it in
// Autofix's name and takes a voicemail: no ring-through, no text-back (the
// line has no SMS sender), no AI front desk. Calls go to `platform_calls`,
// which no garage can read; Vitalos staff see them on the super admin's
// Calls page as "Autofix (platform line)".

import { isE164 } from "@/lib/messaging/phone";

export const PLATFORM_VOICE_NUMBERS_ENV = "AUTOFIX_PLATFORM_VOICE_NUMBERS";

/** The name the greeting uses on the platform line. */
export const PLATFORM_LINE_NAME = "Autofix";

/** Platform numbers from the environment. Anything that is not E.164 is ignored. */
export function platformVoiceNumbers(env: Readonly<Record<string, string | undefined>> = process.env): ReadonlySet<string> {
  const raw = env[PLATFORM_VOICE_NUMBERS_ENV] ?? "";
  return new Set(raw.split(",").map((value) => value.trim()).filter((value) => isE164(value)));
}
