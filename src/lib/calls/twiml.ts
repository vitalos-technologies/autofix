// TwiML for the garage's Autofix number (P4.1). Pure.
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

/** `agent` (P5.12): how the hand-off to the Workforce voice agent went. */
export type VoiceStep = "dial" | "recorded" | "recording" | "agent";

export function isVoiceStep(value: string | null): value is VoiceStep {
  return value === "dial" || value === "recorded" || value === "recording" || value === "agent";
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

/** Autofix's own line (A420): the greeting in Autofix's name, then the same voicemail. */
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

/**
 * P5.12 hand-off: put the caller through to the Workforce voice agent over SIP; Twilio then asks
 * `actionUrl` (?step=agent) with DialCallStatus, and an unanswered leg falls back to the voicemail.
 */
export function agentDialTwiml(input: { sipUri: string; actionUrl: string; timeoutSeconds?: number }) {
  const timeout = Math.max(5, Math.min(60, Math.trunc(input.timeoutSeconds ?? DIAL_TIMEOUT_SECONDS)));
  return `<Dial timeout="${timeout}" answerOnBridge="true" action="${escapeXml(input.actionUrl)}" method="POST"><Sip>${escapeXml(input.sipUri)}</Sip></Dial>`;
}

export function afterRecordingTwiml() {
  return `${say("Thanks for your message. Goodbye.")}<Hangup/>`;
}

/** Twilio recording links we accept: the account's own Recordings resource, nothing else (the voicemail proxy attaches credentials). */
export const TWILIO_RECORDING_URL = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9a-fA-F]{32}\/Recordings\/RE[0-9a-fA-F]{32}$/;

export function isTwilioRecordingUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && TWILIO_RECORDING_URL.test(value);
}
