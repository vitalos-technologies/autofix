// TwiML for the garage's Pitline number (P4.1). Pure.
//
// Docs read 28 Oct 2026: <Dial> https://www.twilio.com/docs/voice/twiml/dial
// (timeout, action + DialCallStatus completed/answered/busy/no-answer/failed/
// canceled, answerOnBridge), <Record> https://www.twilio.com/docs/voice/twiml/record
// (maxLength, timeout = seconds of silence, playBeep, trim, action,
// recordingStatusCallback + recordingStatusCallbackEvent; an empty recording
// skips the action and moves on to the next verb; transcription only when
// `transcribe` is set, which we never do), <Say> language en-GB.

/** The voicemail is at most two minutes. */
export const VOICEMAIL_MAX_SECONDS = 120;
/** How long the garage's own phone rings before the call counts as missed. */
export const DIAL_TIMEOUT_SECONDS = 20;

/** Dial outcomes after which the caller was not put through: the call is missed. */
export const MISSED_DIAL_STATUSES = new Set(["busy", "no-answer", "failed", "canceled"]);

/** `relay` (P5.12 voice desk): how the AI front desk call went (Twilio's <Connect action> callback). */
export type VoiceStep = "dial" | "recorded" | "recording" | "relay";

export function isVoiceStep(value: string | null): value is VoiceStep {
  return value === "dial" || value === "recorded" || value === "recording" || value === "relay";
}

export function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character] ?? character);
}

/** The webhook URL Twilio signed, with `?step=<step>` instead of its query. */
export function voiceStepUrl(signedUrl: string, step: VoiceStep) {
  const url = new URL(signedUrl);
  url.search = `?step=${step}`;
  url.hash = "";
  return url.toString();
}

function say(text: string) {
  return `<Say language="en-GB">${escapeXml(text)}</Say>`;
}

/** Ring the garage's own phone first; Twilio then asks `actionUrl` with DialCallStatus. */
export function dialTwiml(input: { number: string; actionUrl: string; timeoutSeconds?: number }) {
  const timeout = Math.max(5, Math.min(60, Math.trunc(input.timeoutSeconds ?? DIAL_TIMEOUT_SECONDS)));
  return `<Dial timeout="${timeout}" answerOnBridge="true" action="${escapeXml(input.actionUrl)}" method="POST"><Number>${escapeXml(input.number)}</Number></Dial>`;
}

/**
 * The greeting in the garage's name and a voicemail. No promise of a text: whether one goes out
 * depends on the rule, the number and opt-outs. A caller who records nothing hears the goodbye.
 */
export function voicemailTwiml(input: { garageName: string; recordedUrl: string; recordingStatusUrl: string }) {
  return recordTwiml(`Sorry, ${input.garageName} can't take your call right now. Please leave a message after the tone and we'll get back to you.`, input);
}

/** Pitline's own line (A420): the greeting in Pitline's name, then the same voicemail. */
export function platformVoicemailTwiml(input: { lineName: string; recordedUrl: string; recordingStatusUrl: string }) {
  return recordTwiml(`Thanks for calling ${input.lineName}. We can't take your call right now. Please leave a message after the tone and we'll get back to you.`, input);
}

function recordTwiml(greeting: string, input: { recordedUrl: string; recordingStatusUrl: string }) {
  return [
    say(greeting),
    `<Record maxLength="${VOICEMAIL_MAX_SECONDS}" timeout="5" playBeep="true" trim="trim-silence" action="${escapeXml(input.recordedUrl)}" method="POST"`
      + ` recordingStatusCallback="${escapeXml(input.recordingStatusUrl)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>`,
    say("We didn't get a message. Goodbye."),
    "<Hangup/>",
  ].join("");
}

/** The AI front desk's first sentence (docs/autofix/legal/consent-and-messaging-wording.md v1.0, "Automated assistant disclosure"). */
export function aiDisclosure(garageName: string) {
  return `Hi, you're through to the automated assistant for ${garageName}. I can check times and book you in, or take a message for the team.`;
}

/**
 * P5.12 voice desk: the disclosure, then the call goes to Pitline's voice service over Twilio
 * ConversationRelay (https://www.twilio.com/docs/voice/twiml/connect/conversationrelay, read 29 Oct
 * 2026). The disclosure plays while the service wakes. When the session ends Twilio asks `actionUrl`
 * (?step=relay) with SessionStatus (ended / completed / failed) and any HandoffData; a failed
 * session falls back to the voicemail. Speech in and out is en-GB; nothing is recorded.
 */
export function aiDeskTwiml(input: { garageName: string; relayUrl: string; actionUrl: string }) {
  return [
    say(aiDisclosure(input.garageName)),
    `<Connect action="${escapeXml(input.actionUrl)}" method="POST">`,
    `<ConversationRelay url="${escapeXml(input.relayUrl)}" language="en-GB" interruptible="any"/>`,
    "</Connect>",
  ].join("");
}

export function afterRecordingTwiml() {
  return `${say("Thanks for your message. Goodbye.")}<Hangup/>`;
}

/** Twilio recording links we accept: the account's own Recordings resource, nothing else (the voicemail proxy attaches credentials). */
export const TWILIO_RECORDING_URL = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9a-fA-F]{32}\/Recordings\/RE[0-9a-fA-F]{32}$/;

export function isTwilioRecordingUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && TWILIO_RECORDING_URL.test(value);
}
