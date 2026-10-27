import "server-only";

import { afterRecordingTwiml, dialTwiml, isTwilioRecordingUrl, isVoiceStep, MISSED_DIAL_STATUSES, voicemailTwiml, voiceStepUrl, type VoiceStep } from "@/lib/calls/twiml";
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
// Logs carry ids, kinds and outcome codes only: never numbers or bodies.

export type TwilioWebhookKind = "sms" | "whatsapp" | "status" | "voice";

export type RoutedNumber = { garageId: string; garageName: string; purpose: string };

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
  /** Stores the voicemail link on the call (by CallSid, unique across garages); false when there is no such call. */
  recordVoicemail(callSid: string, voicemail: { url: string; durationSeconds: number | null }): Promise<boolean>;
  queueTextBack(garageId: string, callId: string): Promise<void>;
}

export type TwilioWebhookDeps = {
  repo: () => TwilioWebhookRepo | null;
  env?: MessagingEnv;
  /** Runs queued work after the response (`after()` in the route). */
  afterResponse?: (task: () => Promise<unknown>) => void;
  /** Drains the jobs the webhook queued (HELP answers, text-backs) after the response. */
  drainQueued?: (kinds: JobKind[]) => Promise<unknown>;
  log?: JobLogger;
};

type Outcome = { status: "processed" | "ignored"; outcome: string; response?: Response; queued?: JobKind[] };

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

type VoiceContext = { signedUrl: string; step: VoiceStep | null };

function voicemail(routed: RoutedNumber, context: VoiceContext) {
  return twimlResponse(voicemailTwiml({
    garageName: routed.garageName,
    recordedUrl: voiceStepUrl(context.signedUrl, "recorded"),
    recordingStatusUrl: voiceStepUrl(context.signedUrl, "recording"),
  }));
}

async function voice(form: Record<string, string>, repo: TwilioWebhookRepo, context: VoiceContext): Promise<Outcome | null> {
  const callSid = form.CallSid?.trim() ?? "";
  if (!SID.test(callSid)) return null;
  if (context.step === "recording") return voicemailStored(form, repo, callSid);
  if (context.step === "recorded") return { status: "processed", outcome: "voicemail_left", response: twimlResponse(afterRecordingTwiml()) };

  const to = stripWhatsApp(form.To);
  if (!isE164(to)) return null;
  if (context.step === "dial") return dialFinished(form, repo, callSid, to, context);

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

    // Ring the garage's own phone first, unless this call is that forward coming back to us.
    const target = await repo.findDialTarget(routed.garageId, to);
    const loop = target !== null
      && (form.ForwardedFrom?.trim() === target || (from !== null && await repo.callerRangRecently(routed.garageId, from, callSid, FORWARD_LOOP_WINDOW_MS)));
    const dialling = target !== null && !loop;
    let queued: JobKind[] | undefined;
    if (record) {
      const { callId } = await repo.recordCall({ garageId: routed.garageId, callSid, from, to, status: callStatus, durationSeconds: null, missed: !dialling });
      if (!dialling && callId) {
        await repo.queueTextBack(routed.garageId, callId);
        queued = ["calls.text_back"];
      }
    }
    const response = dialling && target
      ? twimlResponse(dialTwiml({ number: target, actionUrl: voiceStepUrl(context.signedUrl, "dial") }))
      : voicemail(routed, context);
    return { status: "processed", outcome: dialling ? "call_dialling" : loop ? "call_forward_returned" : "call_missed", response, queued };
  };

  // A repeated request (Twilio retrying a slow answer) gets the same TwiML, without the writes.
  if (!claimed) return { ...(await answer(false)), outcome: "duplicate", queued: undefined };
  return withEvent(repo, eventKey, () => answer(true));
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
    let queued: JobKind[] | undefined;
    if (record) {
      const { callId } = await repo.recordDialOutcome(routed.garageId, callSid, { dialStatus, missed, durationSeconds: seconds(form.DialCallDuration, 86_400) });
      if (missed && callId) {
        await repo.queueTextBack(routed.garageId, callId);
        queued = ["calls.text_back"];
      }
    }
    return {
      status: "processed",
      outcome: missed ? "dial_missed" : "dial_answered",
      response: missed ? voicemail(routed, context) : twimlResponse("<Hangup/>"),
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
      outcome = await voice(verified.form, repo, { signedUrl: twilioWebhookUrl(request, deps.env), step: isVoiceStep(step) ? step : null });
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
  if (outcome.queued?.length && deps.drainQueued) {
    const drain = deps.drainQueued;
    const kinds = outcome.queued;
    (deps.afterResponse ?? ((task) => void task().catch(() => undefined)))(() => drain(kinds));
  }
  return outcome.response ?? twimlResponse();
}
