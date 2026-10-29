import "server-only";

import { parseVoiceRelayTarget, relayConnectUrl, type VoiceRelayTarget } from "@/lib/ai-front-desk/voice-relay";
import { PLATFORM_LINE_NAME, platformVoiceNumbers } from "@/lib/calls/platform-line";
import { afterRecordingTwiml, aiDeskTwiml, dialTwiml, isTwilioRecordingUrl, isVoiceStep, MISSED_DIAL_STATUSES, platformVoicemailTwiml, voicemailTwiml, voiceStepUrl, type VoiceStep } from "@/lib/calls/twiml";
import { getPlansConfig } from "@/lib/plans/config";
import { createJobLogger } from "@/lib/jobs/log";
import { safeErrorCode, type JobKind, type JobLogger } from "@/lib/jobs/types";
import type { ChannelKind, DeliveryStatus } from "./channel";
import type { MessagingEnv } from "./config";
import type { InboundIntent } from "./keywords";
import { isE164 } from "./phone";
import { parseTwilioInboundMessage, parseTwilioStatusCallback } from "./twilio";
import { readVerifiedTwilioRequest, twilioWebhookUrl, twimlResponse, webhookErrorResponse } from "./webhook-request";

// POST /api/webhooks/twilio/{sms,whatsapp,status,voice} (P3.8).
//
// Every request: signature on the raw body first (nothing is read or stored
// before it passes), then the idempotency row (twilio_webhook_events), then
// the work, then a quick answer. Only light database writes happen here;
// anything that calls a provider (the HELP answer) is queued as a job and
// run after the response.
//
// - sms / whatsapp: the garage comes from the number the customer texted, and
//   only from numbers the platform provisioned (garage_phone_numbers with
//   provider_sid, A55). The text is stored in `messages`. STOP opts the
//   customer out of that garage at once and cancels their scheduled
//   reminders; START lifts it only when consent is on record; HELP queues an
//   answer with the garage's contact details (unless Twilio's Advanced
//   Opt-Out already answered: OptOutType is set).
// - status: delivery receipts move `messages` and `reminder_sends` forward
//   only (isLaterStatus: callbacks arrive out of order).
// - voice (P4.1): logs the call in `calls`; rings the garage's own phone
//   first when it has one (a `forwarding` number it entered, without
//   provider_sid), and when that is busy, unanswered or fails, or when there is
//   no such number, plays a greeting in the garage's name and takes a
//   voicemail (?step=recorded / ?step=recording store its link). A missed call
//   queues `calls.text_back`, drained after the response, so the caller gets
//   the text within seconds.
// - voice, AI front desk (P5.12 voice desk, Pro): where a call is missed, a
//   garage on Pro with the front desk switched on and AI minutes left this
//   month (ai_front_desk_voice_ready()) hears the AI disclosure and is
//   connected to Autofix's voice service over Twilio ConversationRelay (no
//   text-back queued); the service is woken while the disclosure plays.
//   ?step=relay: a session that failed (service down) falls back to the
//   voicemail and the text-back; one the service ended asking for a message
//   gets the voicemail. Without the voice service configured
//   (VOICE_RELAY_URL, VOICE_RELAY_SECRET), or if the check fails, the flow
//   above is unchanged (src/lib/ai-front-desk/hand-off.ts).
// - voice, a number Autofix bought for a garage's AI front desk (D22, A432):
//   garage_phone_numbers.ring_garage_first is false. The garage's own phone
//   diverts missed calls to it, so the garage's phone is never rung first
//   (that would loop back here): straight to the AI front desk, or the
//   voicemail and text-back when the desk can't take the call.
// - voice, Autofix's own line (A420): a number in AUTOFIX_PLATFORM_VOICE_NUMBERS
//   belongs to no garage. The call is logged in `platform_calls` (which no
//   garage can read), greeted in Autofix's name and sent to the voicemail: no
//   ring-through, no text-back, no AI front desk (src/lib/calls/platform-line.ts).
// Logs carry ids, kinds and outcome codes only: never numbers or bodies.

export type TwilioWebhookKind = "sms" | "whatsapp" | "status" | "voice";

export type RoutedNumber = {
  garageId: string;
  garageName: string;
  purpose: string;
  /**
   * D22, A432: false for a number Autofix bought for the garage's AI front desk. The garage's own phone forwards
   * its missed calls there, so the call never rings that phone again (it would come straight back: a loop).
   * Absent means true (every other number, as before).
   */
  ringGarageFirst?: boolean;
};

export type InboundMessageRow = {
  garageId: string;
  customerId: string | null;
  channel: Extract<ChannelKind, "sms" | "whatsapp">;
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
};

export type CallRecord = {
  garageId: string;
  callSid: string;
  from: string | null;
  to: string;
  status: string;
  durationSeconds: number | null;
  missed: boolean;
};

/** A call to Autofix's own line (A420): no garage, so no dial outcome and no text-back. */
export type PlatformCallRecord = {
  callSid: string;
  from: string | null;
  to: string;
  status: string;
  durationSeconds: number | null;
};

export type DialOutcome = { dialStatus: string; missed: boolean; durationSeconds: number | null };

export type KeywordResult = { customers: number; cancelled: number; unchanged: number };

/** Storage for the webhooks. `createSupabaseTwilioWebhookRepo` is the real one; tests pass fakes. */
export interface TwilioWebhookRepo {
  claimEvent(eventKey: string, kind: TwilioWebhookKind, providerSid: string): Promise<boolean>;
  finishEvent(eventKey: string, status: "processed" | "ignored" | "failed", outcome?: string | null, errorCode?: string | null): Promise<void>;
  /** The garage behind a provisioned number (provider_sid set), or null. */
  findGarageByNumber(number: string): Promise<RoutedNumber | null>;
  findCustomerId(garageId: string, phone: string): Promise<string | null>;
  /** Null when a message with this provider id is already stored. */
  insertInboundMessage(row: InboundMessageRow): Promise<{ id: string } | null>;
  applyKeyword(garageId: string, phone: string, intent: "stop" | "start"): Promise<KeywordResult>;
  /** Garages that texted this number in the last 12 months (STOP sent to a number we cannot route). */
  garagesThatMessaged(phone: string): Promise<string[]>;
  applyDeliveryStatus(providerMessageId: string, status: DeliveryStatus, errorCode: number | null): Promise<{ messages: number; reminders: number }>;
  /** Inserts the call or moves its status forward. `callId` is null only when the call belongs to another garage. */
  recordCall(call: CallRecord): Promise<{ outcome: "created" | "updated" | "unchanged"; callId: string | null }>;
  queueHelpReply(garageId: string, inboundMessageId: string): Promise<void>;
  /** The garage's own phone to ring first: a UK `forwarding` number it entered (no provider_sid), never the called number. */
  findDialTarget(garageId: string, calledNumber: string): Promise<string | null>;
  /** Whether this caller rang this garage in the last `withinMs` on another call (a forward that came back to us). */
  callerRangRecently(garageId: string, from: string, callSid: string, withinMs: number): Promise<boolean>;
  recordDialOutcome(garageId: string, callSid: string, outcome: DialOutcome): Promise<{ callId: string | null }>;
  /** A420: inserts a call to Autofix's own line in `platform_calls`, or moves its status forward. */
  recordPlatformCall(call: PlatformCallRecord): Promise<{ outcome: "created" | "updated" | "unchanged" }>;
  /** Stores the voicemail link on the call by CallSid (unique across garages), in `calls` or else `platform_calls`; false when there is no such call. */
  recordVoicemail(callSid: string, voicemail: { url: string; durationSeconds: number | null }): Promise<boolean>;
  queueTextBack(garageId: string, callId: string): Promise<void>;
  /** P5.12: hand this missed call to the AI front desk (ai_front_desk_voice_ready(), minutes under `allowance`)? Absent means never. */
  aiFrontDeskVoiceReady?(garageId: string, allowance: number | null): Promise<boolean>;
  /** P5.12: the call row for a CallSid in this garage (the text-back after a failed AI front desk session). */
  findCallId?(garageId: string, callSid: string): Promise<string | null>;
}

export type TwilioWebhookDeps = {
  repo: () => TwilioWebhookRepo | null;
  env?: MessagingEnv;
  /** Runs queued work after the response (`after()` in the route). */
  afterResponse?: (task: () => Promise<unknown>) => void;
  /** Drains the jobs the webhook queued (HELP answers, text-backs) after the response. */
  drainQueued?: (kinds: JobKind[]) => Promise<unknown>;
  log?: JobLogger;
  /** P5.12: the voice service; undefined reads VOICE_RELAY_URL / VOICE_RELAY_SECRET from `env` (or process.env). */
  voiceRelayTarget?: VoiceRelayTarget | null;
  /** Wakes the voice service (GET its health URL) after the response, while the disclosure plays. */
  prewarm?: (url: string) => Promise<unknown>;
  /** A420: Autofix's own numbers; undefined reads AUTOFIX_PLATFORM_VOICE_NUMBERS from `env` (or process.env). */
  platformVoiceNumbers?: ReadonlySet<string>;
};

/** `prewarm`: a URL to fetch after the response (the voice service's health check). */
type Outcome = { status: "processed" | "ignored"; outcome: string; response?: Response; queued?: JobKind[]; prewarm?: string };

const defaultLog = createJobLogger({ source: "twilio_webhook" });

// Twilio's placeholders for withheld caller ids (https://www.twilio.com/docs/voice/api/call-resource).
const WITHHELD_CALLERS = new Set(["+266696687", "+86282452253", "+8656696", "+7378742833", "+2562533"]);
const CALL_STATUSES = new Set(["queued", "initiated", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled"]);
const LIVE_CALL_STATUSES = new Set(["queued", "initiated", "ringing", "in-progress"]);
const SID = /^[A-Za-z0-9]{2,64}$/;

function stripWhatsApp(value: string | undefined) {
  return value?.trim().replace(/^whatsapp:/i, "") ?? "";
}

async function inbound(form: Record<string, string>, kind: "sms" | "whatsapp", repo: TwilioWebhookRepo): Promise<Outcome | null> {
  const message = parseTwilioInboundMessage(form);
  if (!message || !SID.test(message.messageSid)) return null;
  const eventKey = `inbound:${message.messageSid}`;
  if (!(await repo.claimEvent(eventKey, kind, message.messageSid))) return { status: "processed", outcome: "duplicate" };

  return withEvent(repo, eventKey, async () => {
    const routed = await repo.findGarageByNumber(message.to);
    if (!routed) {
      if (message.intent !== "stop") return { status: "ignored", outcome: "unrouted" };
      // Honour STOP even when the number cannot be routed: every garage that texted this person stops.
      const garages = await repo.garagesThatMessaged(message.from);
      for (const garageId of garages) await repo.applyKeyword(garageId, message.from, "stop");
      return { status: garages.length ? "processed" : "ignored", outcome: garages.length ? "stop_unrouted" : "unrouted" };
    }

    const customerId = await repo.findCustomerId(routed.garageId, message.from);
    const stored = await repo.insertInboundMessage({
      garageId: routed.garageId,
      customerId,
      channel: message.channel,
      from: message.from,
      to: message.to,
      body: message.body.slice(0, 10_000),
      providerMessageId: message.messageSid,
    });
    return keywordOutcome(message.intent, form, routed, message.from, stored, repo);
  });
}

async function keywordOutcome(
  intent: InboundIntent,
  form: Record<string, string>,
  routed: RoutedNumber,
  from: string,
  stored: { id: string } | null,
  repo: TwilioWebhookRepo,
): Promise<Outcome> {
  if (intent === "stop") {
    await repo.applyKeyword(routed.garageId, from, "stop");
    return { status: "processed", outcome: "stop" };
  }
  if (intent === "start") {
    const result = await repo.applyKeyword(routed.garageId, from, "start");
    return { status: "processed", outcome: result.customers > 0 ? "start" : "start_without_consent" };
  }
  if (intent === "help") {
    // With Advanced Opt-Out, Twilio has already answered HELP itself (it then sends OptOutType).
    if (form.OptOutType?.trim() || !stored) return { status: "processed", outcome: "help_answered_by_twilio" };
    await repo.queueHelpReply(routed.garageId, stored.id);
    return { status: "processed", outcome: "help", queued: ["messages.reply"] };
  }
  return { status: "processed", outcome: stored ? "stored" : "already_stored" };
}

async function status(form: Record<string, string>, repo: TwilioWebhookRepo): Promise<Outcome | null> {
  const callback = parseTwilioStatusCallback(form);
  if (!callback || !SID.test(callback.messageSid) || !/^[a-z_]{1,30}$/.test(callback.rawStatus || "unknown")) return null;
  const eventKey = `status:${callback.messageSid}:${callback.rawStatus || "unknown"}`;
  if (!(await repo.claimEvent(eventKey, "status", callback.messageSid))) return { status: "processed", outcome: "duplicate" };
  return withEvent(repo, eventKey, async () => {
    const applied = await repo.applyDeliveryStatus(callback.messageSid, callback.status, callback.errorCode);
    if (applied.messages + applied.reminders === 0) return { status: "ignored", outcome: "not_newer_or_unknown" };
    return { status: "processed", outcome: `status_${callback.status}` };
  });
}

/** A Twilio caller id we can store and text: E.164 and not one of Twilio's withheld placeholders. */
function callerNumber(raw: string | undefined) {
  const value = raw?.trim() ?? "";
  return isE164(value) && !WITHHELD_CALLERS.has(value) ? value : null;
}

function seconds(raw: string | undefined, max: number) {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(max, Math.trunc(value)) : null;
}

/** How recent another call from the same caller must be to treat this one as our own forward coming back. */
const FORWARD_LOOP_WINDOW_MS = 2 * 60 * 1000;
const DIAL_STATUSES = new Set(["completed", "answered", "busy", "no-answer", "failed", "canceled"]);

type VoiceContext = { signedUrl: string; step: VoiceStep | null; relay: VoiceRelayTarget | null; aiMinutesAllowance: number | null; platformNumbers: ReadonlySet<string> };

function voicemail(routed: RoutedNumber, context: VoiceContext) {
  return twimlResponse(voicemailTwiml({
    garageName: routed.garageName,
    recordedUrl: voiceStepUrl(context.signedUrl, "recorded"),
    recordingStatusUrl: voiceStepUrl(context.signedUrl, "recording"),
  }));
}

/**
 * P5.12 hook point: the voice service when this missed call goes to the AI front desk, else null
 * (Essentials, switched off, minutes used up, not configured, or the check failed: never lose a call over it).
 */
async function aiFrontDeskTarget(repo: TwilioWebhookRepo, garageId: string, context: VoiceContext): Promise<VoiceRelayTarget | null> {
  if (!context.relay || !repo.aiFrontDeskVoiceReady) return null;
  try {
    return (await repo.aiFrontDeskVoiceReady(garageId, context.aiMinutesAllowance)) ? context.relay : null;
  } catch {
    return null;
  }
}

function relayConnect(target: VoiceRelayTarget, routed: RoutedNumber, callSid: string, context: VoiceContext) {
  return twimlResponse(aiDeskTwiml({
    garageName: routed.garageName,
    relayUrl: relayConnectUrl(target, { garageId: routed.garageId, callSid }),
    actionUrl: voiceStepUrl(context.signedUrl, "relay"),
  }));
}

async function voice(form: Record<string, string>, repo: TwilioWebhookRepo, context: VoiceContext): Promise<Outcome | null> {
  const callSid = form.CallSid?.trim() ?? "";
  if (!SID.test(callSid)) return null;
  if (context.step === "recording") return voicemailStored(form, repo, callSid);
  if (context.step === "recorded") return { status: "processed", outcome: "voicemail_left", response: twimlResponse(afterRecordingTwiml()) };

  const to = stripWhatsApp(form.To);
  if (!isE164(to)) return null;
  if (context.platformNumbers.has(to)) return platformVoice(form, repo, callSid, to, context);
  if (context.step === "dial") return dialFinished(form, repo, callSid, to, context);
  if (context.step === "relay") return relayFinished(form, repo, callSid, to, context);

  const rawStatus = form.CallStatus?.trim().toLowerCase() || "ringing";
  const callStatus = CALL_STATUSES.has(rawStatus) ? rawStatus : "ringing";
  const live = LIVE_CALL_STATUSES.has(callStatus);
  const eventKey = `voice:${callSid}:${callStatus}`;
  const claimed = await repo.claimEvent(eventKey, "voice", callSid);
  const from = callerNumber(form.From);

  const answer = async (record: boolean): Promise<Outcome> => {
    const routed = await repo.findGarageByNumber(to);
    if (!routed) return { status: "ignored", outcome: "unrouted", response: twimlResponse("<Reject/>") };
    if (!live) {
      // A status callback (completed, no-answer, ...): move the call forward, answer nothing.
      if (record) {
        await repo.recordCall({ garageId: routed.garageId, callSid, from, to, status: callStatus, durationSeconds: seconds(form.CallDuration, 86_400), missed: true });
      }
      return { status: "processed", outcome: "call_status", response: twimlResponse() };
    }

    // Ring the garage's own phone first, unless the garage forwards its missed calls to this number (A432),
    // or this call is that forward coming back to us.
    const forwardedHere = routed.ringGarageFirst === false;
    const target = forwardedHere ? null : await repo.findDialTarget(routed.garageId, to);
    const loop = target !== null
      && (form.ForwardedFrom?.trim() === target || (from !== null && await repo.callerRangRecently(routed.garageId, from, callSid, FORWARD_LOOP_WINDOW_MS)));
    const dialling = target !== null && !loop;
    const agent = dialling ? null : await aiFrontDeskTarget(repo, routed.garageId, context);
    let queued: JobKind[] | undefined;
    if (record) {
      const { callId } = await repo.recordCall({ garageId: routed.garageId, callSid, from, to, status: callStatus, durationSeconds: null, missed: !dialling });
      if (!dialling && !agent && callId) {
        await repo.queueTextBack(routed.garageId, callId);
        queued = ["calls.text_back"];
      }
    }
    const response = dialling && target
      ? twimlResponse(dialTwiml({ number: target, actionUrl: voiceStepUrl(context.signedUrl, "dial") }))
      : agent ? relayConnect(agent, routed, callSid, context) : voicemail(routed, context);
    const outcome = dialling ? "call_dialling" : agent ? "call_ai_front_desk" : loop ? "call_forward_returned" : forwardedHere ? "call_forwarded_missed" : "call_missed";
    return { status: "processed", outcome, response, queued, prewarm: agent?.healthUrl };
  };

  // A repeated request (Twilio retrying a slow answer) gets the same TwiML, without the writes.
  if (!claimed) return { ...(await answer(false)), outcome: "duplicate", queued: undefined };
  return withEvent(repo, eventKey, () => answer(true));
}

/**
 * A420: a call to Autofix's own line. Logged in `platform_calls`, greeted in Autofix's name, then the
 * voicemail (the recording steps are shared with garage calls). Nothing rings and nothing is texted.
 */
async function platformVoice(form: Record<string, string>, repo: TwilioWebhookRepo, callSid: string, to: string, context: VoiceContext): Promise<Outcome> {
  // We never dial out or hand off on this line, so a dial or relay step is not ours: end the call.
  if (context.step) return { status: "ignored", outcome: "platform_step_unexpected", response: twimlResponse("<Hangup/>") };
  const rawStatus = form.CallStatus?.trim().toLowerCase() || "ringing";
  const callStatus = CALL_STATUSES.has(rawStatus) ? rawStatus : "ringing";
  const live = LIVE_CALL_STATUSES.has(callStatus);
  const eventKey = `voice:${callSid}:${callStatus}`;
  const claimed = await repo.claimEvent(eventKey, "voice", callSid);
  const response = live
    ? twimlResponse(platformVoicemailTwiml({
      lineName: PLATFORM_LINE_NAME,
      recordedUrl: voiceStepUrl(context.signedUrl, "recorded"),
      recordingStatusUrl: voiceStepUrl(context.signedUrl, "recording"),
    }))
    : twimlResponse();
  const outcome = live ? "platform_call_voicemail" : "platform_call_status";
  if (!claimed) return { status: "processed", outcome: "duplicate", response };
  return withEvent(repo, eventKey, async () => {
    await repo.recordPlatformCall({
      callSid,
      from: callerNumber(form.From),
      to,
      status: callStatus,
      durationSeconds: live ? null : seconds(form.CallDuration, 86_400),
    });
    return { status: "processed", outcome, response };
  });
}

/** `?step=dial`: how ringing the garage's own phone went (DialCallStatus). */
async function dialFinished(form: Record<string, string>, repo: TwilioWebhookRepo, callSid: string, to: string, context: VoiceContext): Promise<Outcome> {
  const raw = form.DialCallStatus?.trim().toLowerCase() ?? "";
  const dialStatus = DIAL_STATUSES.has(raw) ? raw : "failed";
  const missed = MISSED_DIAL_STATUSES.has(dialStatus);
  const eventKey = `voice:${callSid}:dial`;
  const claimed = await repo.claimEvent(eventKey, "voice", callSid);

  const answer = async (record: boolean): Promise<Outcome> => {
    const routed = await repo.findGarageByNumber(to);
    if (!routed) return { status: "ignored", outcome: "unrouted", response: twimlResponse("<Hangup/>") };
    const agent = missed ? await aiFrontDeskTarget(repo, routed.garageId, context) : null;
    let queued: JobKind[] | undefined;
    if (record) {
      const { callId } = await repo.recordDialOutcome(routed.garageId, callSid, { dialStatus, missed, durationSeconds: seconds(form.DialCallDuration, 86_400) });
      if (missed && !agent && callId) {
        await repo.queueTextBack(routed.garageId, callId);
        queued = ["calls.text_back"];
      }
    }
    return {
      status: "processed",
      outcome: missed ? (agent ? "dial_missed_ai_front_desk" : "dial_missed") : "dial_answered",
      response: missed ? (agent ? relayConnect(agent, routed, callSid, context) : voicemail(routed, context)) : twimlResponse("<Hangup/>"),
      queued,
      prewarm: agent?.healthUrl,
    };
  };

  if (!claimed) return { ...(await answer(false)), outcome: "duplicate", queued: undefined };
  return withEvent(repo, eventKey, () => answer(true));
}

/** HandoffData the voice service ends a session with when the caller would rather leave a message. */
const RELAY_HANDOFF_VOICEMAIL = "voicemail";

function handoffTarget(raw: string | undefined) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    return data && typeof data === "object" && typeof (data as { to?: unknown }).to === "string" ? (data as { to: string }).to : null;
  } catch {
    return null;
  }
}

/**
 * `?step=relay` (P5.12 voice desk): the AI front desk session is over (Twilio's <Connect action>).
 * `failed` (the service could not be reached or broke): the Essentials fallback, voicemail plus the
 * text-back. `ended` with HandoffData {"to":"voicemail"}: the caller leaves a message. Anything else
 * (the caller hung up, or the desk finished and said goodbye): hang up. The service reports the
 * minutes and its summary itself.
 */
async function relayFinished(form: Record<string, string>, repo: TwilioWebhookRepo, callSid: string, to: string, context: VoiceContext): Promise<Outcome> {
  const sessionStatus = form.SessionStatus?.trim().toLowerCase() ?? "";
  const failed = sessionStatus === "failed" || sessionStatus === "error";
  const toVoicemail = !failed && sessionStatus === "ended" && handoffTarget(form.HandoffData) === RELAY_HANDOFF_VOICEMAIL;
  const callerGone = form.CallStatus?.trim().toLowerCase() === "completed";
  const eventKey = `voice:${callSid}:relay`;
  const claimed = await repo.claimEvent(eventKey, "voice", callSid);

  const answer = async (record: boolean): Promise<Outcome> => {
    const routed = await repo.findGarageByNumber(to);
    if (!routed) return { status: "ignored", outcome: "unrouted", response: twimlResponse("<Hangup/>") };
    let queued: JobKind[] | undefined;
    if (record && failed && repo.findCallId) {
      const callId = await repo.findCallId(routed.garageId, callSid);
      if (callId) {
        await repo.queueTextBack(routed.garageId, callId);
        queued = ["calls.text_back"];
      }
    }
    const voicemailNext = (failed || toVoicemail) && !callerGone;
    return {
      status: "processed",
      outcome: failed ? "relay_failed" : toVoicemail ? "relay_voicemail" : "relay_ended",
      response: voicemailNext ? voicemail(routed, context) : twimlResponse("<Hangup/>"),
      queued,
    };
  };

  if (!claimed) return { ...(await answer(false)), outcome: "duplicate", queued: undefined };
  return withEvent(repo, eventKey, () => answer(true));
}

/** `?step=recording`: the voicemail is ready; its link goes on the call. */
async function voicemailStored(form: Record<string, string>, repo: TwilioWebhookRepo, callSid: string): Promise<Outcome> {
  const url = form.RecordingUrl?.trim();
  if (form.RecordingStatus?.trim().toLowerCase() !== "completed" || !isTwilioRecordingUrl(url)) {
    return { status: "ignored", outcome: "recording_not_usable", response: twimlResponse() };
  }
  const eventKey = `voice:${callSid}:recording`;
  if (!(await repo.claimEvent(eventKey, "voice", callSid))) return { status: "processed", outcome: "duplicate", response: twimlResponse() };
  return withEvent(repo, eventKey, async () => {
    const stored = await repo.recordVoicemail(callSid, { url, durationSeconds: seconds(form.RecordingDuration, 3_600) });
    return { status: stored ? "processed" : "ignored", outcome: stored ? "voicemail_stored" : "call_unknown", response: twimlResponse() };
  });
}

async function withEvent(repo: TwilioWebhookRepo, eventKey: string, work: () => Promise<Outcome>): Promise<Outcome> {
  try {
    const outcome = await work();
    await repo.finishEvent(eventKey, outcome.status, outcome.outcome);
    return outcome;
  } catch (error) {
    const code = safeErrorCode(error).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
    await repo.finishEvent(eventKey, "failed", null, code).catch(() => undefined);
    throw error;
  }
}

/** The whole webhook: verify, claim, process, answer. Never logs numbers or bodies. */
export async function handleTwilioWebhook(request: Request, kind: TwilioWebhookKind, deps: TwilioWebhookDeps): Promise<Response> {
  const verified = await readVerifiedTwilioRequest(request, deps.env);
  if (!verified.ok) return webhookErrorResponse(verified.status, verified.code);

  const repo = deps.repo();
  if (!repo) return webhookErrorResponse(503, "not_configured");
  const log = deps.log ?? defaultLog;

  let outcome: Outcome | null;
  try {
    if (kind === "voice") {
      const step = new URL(request.url).searchParams.get("step");
      const env = deps.env ?? process.env;
      const relay = deps.voiceRelayTarget !== undefined ? deps.voiceRelayTarget : parseVoiceRelayTarget(env);
      outcome = await voice(verified.form, repo, {
        signedUrl: twilioWebhookUrl(request, deps.env),
        step: isVoiceStep(step) ? step : null,
        relay,
        aiMinutesAllowance: getPlansConfig(env).pro.aiMinutesAllowance,
        platformNumbers: deps.platformVoiceNumbers ?? platformVoiceNumbers(env),
      });
    } else {
      outcome = kind === "status" ? await status(verified.form, repo) : await inbound(verified.form, kind, repo);
    }
  } catch (error) {
    log.error("twilio_webhook_failed", { kind, error: safeErrorCode(error) });
    return webhookErrorResponse(500, "processing_failed");
  }

  if (!outcome) {
    // Signed by Twilio but not something we can use (e.g. a sender without a phone number).
    log.warn("twilio_webhook_unusable", { kind });
    return kind === "voice" ? twimlResponse("<Reject/>") : twimlResponse();
  }

  log.info("twilio_webhook", { kind, outcome: outcome.outcome });
  const schedule = deps.afterResponse ?? ((task) => void task().catch(() => undefined));
  if (outcome.prewarm) {
    const url = outcome.prewarm;
    const prewarm = deps.prewarm ?? ((target: string) => fetch(target, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(20_000) }));
    schedule(() => prewarm(url));
  }
  if (outcome.queued?.length && deps.drainQueued) {
    const drain = deps.drainQueued;
    const kinds = outcome.queued;
    schedule(() => drain(kinds));
  }
  return outcome.response ?? twimlResponse();
}
