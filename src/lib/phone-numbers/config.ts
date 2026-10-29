// Settings of the number provisioning step (D22), from env. No secrets here: the Twilio credentials are
// read by the client (src/lib/messaging/twilio-numbers.ts) and never pass through this module.
//
//   TWILIO_NUMBER_CAP   the most numbers the Twilio account may hold (all of them, the platform line and the
//                       texting number included). At or over it nothing is bought. Default 20 (Temitope's
//                       proposal, to confirm). A value that is not a whole number from 0 to 1000 means 20.
//   TWILIO_WEBHOOK_BASE_URL, else NEXT_PUBLIC_SITE_URL
//                       the https origin the bought numbers' calls and call status are pointed at
//                       (<origin>/api/webhooks/twilio/voice).
//   AUTOFIX_PLATFORM_VOICE_NUMBERS
//                       Autofix's own line(s) (A420): never bought, adopted, routed or counted as a texting
//                       number.

import { platformVoiceNumbers } from "@/lib/calls/platform-line";

export const TWILIO_NUMBER_CAP_ENV = "TWILIO_NUMBER_CAP";
export const DEFAULT_NUMBER_CAP = 20;
const MAX_NUMBER_CAP = 1000;
export const VOICE_WEBHOOK_PATH = "/api/webhooks/twilio/voice";

type Env = Readonly<Record<string, string | undefined>>;

export type NumbersConfig = {
  cap: number;
  /** `https://…/api/webhooks/twilio/voice`, or null when no https origin is configured. */
  voiceUrl: string | null;
  platformNumbers: ReadonlySet<string>;
};

export function numberCap(env: Env = process.env): number {
  const raw = env[TWILIO_NUMBER_CAP_ENV]?.trim();
  if (!raw || !/^\d{1,4}$/.test(raw)) return DEFAULT_NUMBER_CAP;
  const value = Number(raw);
  return value <= MAX_NUMBER_CAP ? value : DEFAULT_NUMBER_CAP;
}

/** The voice webhook on the public https origin (with any path prefix), or null. */
export function voiceWebhookUrl(env: Env = process.env): string | null {
  for (const name of ["TWILIO_WEBHOOK_BASE_URL", "NEXT_PUBLIC_SITE_URL"]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}${VOICE_WEBHOOK_PATH}`;
    } catch {
      continue;
    }
  }
  return null;
}

export function readNumbersConfig(env: Env = process.env): NumbersConfig {
  return { cap: numberCap(env), voiceUrl: voiceWebhookUrl(env), platformNumbers: platformVoiceNumbers(env) };
}
