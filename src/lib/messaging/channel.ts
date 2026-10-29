import "server-only";

// MessageChannel: the one interface the reminders engine, booking
// notifications and missed-call text-back send through (SPEC "Reminders and
// messaging engine", ARCHITECTURE Phase 3 "App").
//
// getChannel(kind) returns a mock channel unless MESSAGING_MODE=live. In live
// mode a channel with missing or malformed credentials still resolves: every
// send returns { ok: false, code: "configuration_required" } and nothing is
// thrown or printed (the SOB /api/health pattern). Mock channels never touch
// the network; they record each send in the shared mock outbox.
//
// This layer is transport only. Consent, opt-out (`customers.opted_out_at`)
// and quiet hours are checked by the caller before send(), at send time.

import { getMessagingMode, readEmailReadiness, readTwilioConfig, type MessagingEnv, type MessagingMode } from "./config";
import { createResendEmailChannel } from "./email";
import { meterSmsChannel } from "./metering";
import { createMockChannel } from "./mock";
import { configurationRequired } from "./results";
import { createTwilioSmsChannel, createTwilioWhatsAppChannel } from "./twilio";

export type ChannelKind = "sms" | "whatsapp" | "email";

/** Normalised delivery state stored on `messages.status` / `reminder_sends.status`. */
export type DeliveryStatus = "queued" | "sent" | "delivered" | "failed";

/**
 * A Meta-approved WhatsApp template (Twilio Content API). WhatsApp requires a
 * template for business-initiated messages outside the 24-hour customer
 * service window; a free-form body there fails with Twilio error 63016.
 */
export type WhatsAppTemplate = {
  /** Content SID, `HX` followed by 32 hex characters. */
  contentSid: string;
  /** Template variables keyed "1", "2", ... */
  variables?: Record<string, string>;
};

export type OutboundMessage = {
  garageId: string;
  /** E.164 (`+447700900123`) for SMS and WhatsApp; an email address for email. */
  to: string;
  /** Plain text. For SMS/WhatsApp render it with renderTemplate(..., { channel }) so it carries the opt-out line. */
  body: string;
  /** Email only. Falls back to the first line of the body. */
  subject?: string;
  /** Email only. */
  html?: string;
  /** Email only: the Reply-To address (e.g. the person who wrote in). Falls back to RESEND_REPLY_TO. */
  replyTo?: string;
  /** SMS only: the garage's alphanumeric sender (1 to 11 characters, at least one letter, e.g. `HartleyRd`). */
  senderId?: string;
  /** SMS/WhatsApp delivery webhook; defaults to TWILIO_STATUS_CALLBACK_BASE_URL + /api/webhooks/twilio/status. */
  statusCallbackUrl?: string;
  /** Stable per logical message (e.g. `reminder_send:<id>`). Repeat sends with the same key are not sent twice where we can prevent it. */
  idempotencyKey: string;
  /** WhatsApp only: send this approved template instead of the free-form body. */
  whatsappTemplate?: WhatsAppTemplate;
};

export type SendFailureCode = "invalid_recipient" | "opted_out" | "configuration_required" | "rate_limited" | "provider_error";

export type SendSuccess = { ok: true; providerMessageId: string; status: DeliveryStatus };

export type SendFailure = {
  ok: false;
  code: SendFailureCode;
  retryable: boolean;
  /** Provider error code (e.g. Twilio 21211) or a local reason such as `timeout`. Safe to log: never contains the recipient or body. */
  providerCode?: number | string;
  /** From the provider's Retry-After header on rate limiting. */
  retryAfterSeconds?: number;
  /** The provider may have accepted the message even though we saw a failure (timeout, connection reset). Check before resending. */
  ambiguous?: boolean;
};

export type SendResult = SendSuccess | SendFailure;

export interface MessageChannel {
  readonly kind: ChannelKind;
  /** `mock` channels never contact a provider. */
  readonly mode: MessagingMode;
  send(message: OutboundMessage): Promise<SendResult>;
}

/** A live channel whose credentials are missing: every send fails closed. */
export function createUnconfiguredChannel(kind: ChannelKind): MessageChannel {
  return {
    kind,
    mode: "live",
    async send() {
      return configurationRequired();
    },
  };
}

/**
 * The channel to send through. Mock unless MESSAGING_MODE=live; in live mode
 * missing credentials give a channel that returns `configuration_required`.
 * `env` is injectable for tests; email configuration is read by
 * src/lib/email/resend.ts from process.env. SMS sends are metered (P5.2,
 * ./metering.ts) after a successful send; metering never changes the result.
 */
export function getChannel(kind: ChannelKind, env: MessagingEnv = process.env): MessageChannel {
  return meterSmsChannel(resolveChannel(kind, env), env);
}

function resolveChannel(kind: ChannelKind, env: MessagingEnv): MessageChannel {
  if (getMessagingMode(env) === "mock") return createMockChannel(kind);

  if (kind === "email") {
    return readEmailReadiness() === "ready" ? createResendEmailChannel({ mode: "live" }) : createUnconfiguredChannel("email");
  }

  const twilio = readTwilioConfig(env);
  if (!twilio.accountSid || !twilio.authToken) return createUnconfiguredChannel(kind);

  if (kind === "sms") {
    if (!twilio.messagingServiceSid) return createUnconfiguredChannel("sms");
    return createTwilioSmsChannel({
      accountSid: twilio.accountSid,
      authToken: twilio.authToken,
      messagingServiceSid: twilio.messagingServiceSid,
      statusCallbackUrl: twilio.statusCallbackUrl,
    });
  }

  if (!twilio.whatsappFrom) return createUnconfiguredChannel("whatsapp");
  return createTwilioWhatsAppChannel({
    accountSid: twilio.accountSid,
    authToken: twilio.authToken,
    whatsappFrom: twilio.whatsappFrom,
    statusCallbackUrl: twilio.statusCallbackUrl,
  });
}

export { getMessagingMode, getMessagingReadiness, type MessagingMode, type MessagingReadiness } from "./config";
export { clearMockOutbox, getMockOutbox, type MockOutboxEntry } from "./mock";
// ARCHITECTURE lists these on channel.ts; they live in templates.ts so client code can import them without server-only.
export { renderTemplate, smsSegments } from "./templates";
