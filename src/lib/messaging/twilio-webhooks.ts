import "server-only";

import { createJobLogger } from "@/lib/jobs/log";
import { safeErrorCode, type JobLogger } from "@/lib/jobs/types";
import type { ChannelKind, DeliveryStatus } from "./channel";
import type { MessagingEnv } from "./config";
import type { InboundIntent } from "./keywords";
import { isE164 } from "./phone";
import { parseTwilioInboundMessage, parseTwilioStatusCallback } from "./twilio";
import { escapeXml, readVerifiedTwilioRequest, twimlResponse, webhookErrorResponse } from "./webhook-request";

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
// - voice: logs the call in `calls` and answers with minimal TwiML (P4.1 adds
//   the text-back and voicemail).
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
  recordCall(call: CallRecord): Promise<"created" | "updated" | "unchanged">;
  queueHelpReply(garageId: string, inboundMessageId: string): Promise<void>;
}

export type TwilioWebhookDeps = {
  repo: () => TwilioWebhookRepo | null;
  env?: MessagingEnv;
  /** Runs queued work after the response (`after()` in the route). */
  afterResponse?: (task: () => Promise<unknown>) => void;
  /** Drains the jobs the webhook queued. */
  drainReplies?: () => Promise<unknown>;
  log?: JobLogger;
};

type Outcome = { status: "processed" | "ignored"; outcome: string; response?: Response; queuedReply?: boolean };

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
    return { status: "processed", outcome: "help", queuedReply: true };
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

async function voice(form: Record<string, string>, repo: TwilioWebhookRepo): Promise<Outcome | null> {
  const callSid = form.CallSid?.trim() ?? "";
  const to = stripWhatsApp(form.To);
  if (!SID.test(callSid) || !isE164(to)) return null;
  const rawStatus = form.CallStatus?.trim().toLowerCase() || "ringing";
  const callStatus = CALL_STATUSES.has(rawStatus) ? rawStatus : "ringing";
  const eventKey = `voice:${callSid}:${callStatus}`;
  const live = LIVE_CALL_STATUSES.has(callStatus);
  if (!(await repo.claimEvent(eventKey, "voice", callSid))) {
    return { status: "processed", outcome: "duplicate", response: live ? twimlResponse("<Hangup/>") : twimlResponse() };
  }

  return withEvent(repo, eventKey, async () => {
    const routed = await repo.findGarageByNumber(to);
    if (!routed) return { status: "ignored", outcome: "unrouted", response: twimlResponse("<Reject/>") };

    const rawFrom = form.From?.trim() ?? "";
    const from = isE164(rawFrom) && !WITHHELD_CALLERS.has(rawFrom) ? rawFrom : null;
    const duration = Number(form.CallDuration ?? form.DialCallDuration ?? NaN);
    const recorded = await repo.recordCall({
      garageId: routed.garageId,
      callSid,
      from,
      to,
      status: callStatus,
      durationSeconds: Number.isFinite(duration) && duration >= 0 ? Math.min(86_400, Math.trunc(duration)) : null,
      // Calls reach the Autofix number only when the garage did not pick up (forward when busy or unanswered).
      missed: true,
    });
    const response = live
      ? twimlResponse(`<Say language="en-GB">Sorry, ${escapeXml(routed.garageName)} can't take your call right now. Please try again later.</Say><Hangup/>`)
      : twimlResponse();
    return { status: "processed", outcome: `call_${recorded}`, response };
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
    outcome = kind === "status" ? await status(verified.form, repo) : kind === "voice" ? await voice(verified.form, repo) : await inbound(verified.form, kind, repo);
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
  if (outcome.queuedReply && deps.drainReplies) {
    const drain = deps.drainReplies;
    (deps.afterResponse ?? ((task) => void task().catch(() => undefined)))(() => drain());
  }
  return outcome.response ?? twimlResponse();
}
