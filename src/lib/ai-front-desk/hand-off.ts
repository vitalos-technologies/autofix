// AI front desk hand-off (P5.12, D17; voice desk AV1–AV10). Pure and client-safe.
//
// A missed call goes to the AI front desk only when ALL of these hold:
//   1. the call is missed (no garage phone to ring first, or it was busy /
//      unanswered / failed), exactly where Essentials plays the voicemail;
//   2. ai_front_desk_voice_ready(garage, allowance) is true: the garage takes
//      bookings, is on Pro (feature ai_front_desk), the owner switched it on at
//      /app/settings/ai-front-desk, and this month's AI minutes are under the
//      Pro allowance (PLAN_PRO_AI_MINUTES; unset = no cap);
//   3. the voice service is configured: VOICE_RELAY_URL (wss://…/relay) and
//      VOICE_RELAY_SECRET (src/lib/ai-front-desk/voice-relay.ts).
// Then the webhook speaks the disclosure and connects the call to the voice
// service (Twilio ConversationRelay), waking it while the disclosure plays.
// Otherwise, or if the check fails, the Essentials flow runs unchanged
// (voicemail + text-back), and a relay session that fails (service down)
// falls back to the same.
//
// Workforce tokens (the "Tokens for Workforce" panel) stay for partner agents
// on other channels; calls no longer depend on Workforce.

/** What the settings page says about partner tokens (no values, only states). */
export type WorkforceConnection = {
  /** Live (not revoked) workforce tokens for this garage. */
  activeTokens: number;
  /** Latest use of any live workforce token, ISO. */
  lastUsedAt: string | null;
};

export function workforceConnectionStatus(connection: WorkforceConnection): { tone: "success" | "warning" | "info"; label: string; detail: string } {
  if (connection.activeTokens === 0) {
    return { tone: "info", label: "No tokens", detail: "Only needed to connect another Vitalos agent, such as WhatsApp. Calls don't need one." };
  }
  if (!connection.lastUsedAt) {
    return { tone: "warning", label: "Not used yet", detail: "A token is ready, but nothing has used it yet." };
  }
  return { tone: "success", label: "In use", detail: "A connected agent has used your token." };
}

/** Where the AI front desk on calls stands for this garage (no values, only states). */
export type VoiceDeskState = {
  /** The platform has the voice service configured (VOICE_RELAY_URL and VOICE_RELAY_SECRET). */
  serviceConfigured: boolean;
  /** The owner switched the front desk on. */
  enabled: boolean;
  /** The garage has a number Twilio routes to Pitline. */
  hasNumber: boolean;
  /** This month's minutes reached the allowance. */
  overAllowance: boolean;
};

export function voiceDeskStatus(state: VoiceDeskState): { tone: "success" | "warning" | "info" | "neutral"; label: string; detail: string } {
  if (!state.enabled) return { tone: "neutral", label: "Off", detail: "Missed calls get your voicemail and a text back." };
  if (!state.serviceConfigured) return { tone: "warning", label: "Waiting for Vitalos", detail: "Vitalos is switching the AI front desk on for calls. Until then missed calls get your voicemail and a text back." };
  if (!state.hasNumber) return { tone: "warning", label: "No Pitline number", detail: "Your garage needs a Pitline phone number for the AI front desk to answer calls. Ask Vitalos to add one." };
  if (state.overAllowance) return { tone: "warning", label: "Allowance used", detail: "This month's AI minutes are used up, so missed calls get your voicemail and a text back until next month." };
  return { tone: "success", label: "Answering", detail: "Missed calls are answered by the AI front desk." };
}
