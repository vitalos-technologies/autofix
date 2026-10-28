// AI front desk hand-off (P5.12, D17). Pure and client-safe.
//
// Where Twilio forwards a missed call to the Workforce voice agent. The hook
// in the voice webhook (src/lib/messaging/twilio-webhooks.ts) hands a call to
// Workforce only when ALL of these hold:
//   1. the call is missed (no garage phone to ring first, or it was busy /
//      unanswered / failed), exactly where Essentials plays the voicemail;
//   2. ai_front_desk_hand_off(garage) is true: the garage takes bookings, is
//      on Pro (feature ai_front_desk) and the owner switched it on at
//      /app/settings/ai-front-desk;
//   3. WORKFORCE_VOICE_SIP_URI is set to a valid sip:/sips: URI (platform-wide,
//      from Workforce; unset today, so nothing is handed off yet).
// Otherwise the Essentials flow runs unchanged (voicemail + text-back). If the
// Workforce leg is not answered (?step=agent with busy/no-answer/failed/
// canceled), the caller falls back to the voicemail and the text-back.
//
// Twilio adds the `?X-…` URI parameters as SIP headers on the INVITE
// (https://www.twilio.com/docs/voice/twiml/sip, read 28 Oct 2026), so Workforce
// learns the garage (to pick its agent token) and the CallSid (the
// conversationId it reports to /api/agent/v1/report_usage). No caller number
// or registration is added.

export const AI_FRONT_DESK_ENV = {
  voiceSipUri: "WORKFORCE_VOICE_SIP_URI",
} as const;

/** sip: or sips: user@host[:port][;params], no headers of its own (we add ours). */
const SIP_URI = /^sips?:[A-Za-z0-9._~%+-]{1,64}@[A-Za-z0-9.-]{1,253}(:\d{1,5})?(;[A-Za-z0-9=._~%+-]{1,100})*$/;

export type WorkforceVoiceTarget = { sipUri: string };

export function parseWorkforceVoiceTarget(value: string | null | undefined): WorkforceVoiceTarget | null {
  const trimmed = value?.trim();
  if (!trimmed || !SIP_URI.test(trimmed)) return null;
  return { sipUri: trimmed };
}

export function workforceVoiceTarget(env: Readonly<Record<string, string | undefined>> = process.env): WorkforceVoiceTarget | null {
  return parseWorkforceVoiceTarget(env[AI_FRONT_DESK_ENV.voiceSipUri]);
}

/** The SIP URI Twilio dials for one call: the Workforce target plus the garage and CallSid as SIP headers. */
export function workforceSipUri(target: WorkforceVoiceTarget, input: { garageId: string; callSid: string }) {
  const params = new URLSearchParams({ "X-Autofix-Garage": input.garageId, "X-Autofix-Call-Sid": input.callSid });
  return `${target.sipUri}?${params.toString()}`;
}

/** What the settings page says about the connection (no values, only states). */
export type WorkforceConnection = {
  /** The platform has a Workforce voice target configured. */
  voiceConfigured: boolean;
  /** Live (not revoked) workforce tokens for this garage. */
  activeTokens: number;
  /** Latest use of any live workforce token, ISO. */
  lastUsedAt: string | null;
};

export function workforceConnectionStatus(connection: WorkforceConnection): { tone: "success" | "warning" | "info"; label: string; detail: string } {
  if (connection.activeTokens === 0) {
    return { tone: "info", label: "Not connected", detail: "Create a token below and give it to Vitalos to connect Workforce." };
  }
  if (!connection.lastUsedAt) {
    return { tone: "warning", label: "Waiting for Workforce", detail: "A token is ready, but Workforce hasn't used it yet." };
  }
  return { tone: "success", label: "Connected", detail: "Workforce has used your token." };
}
