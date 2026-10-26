import "server-only";

// Email MessageChannel over the existing Resend helper
// (src/lib/email/resend.ts sendTransactionalEmail), so sender, reply-to and
// error classification stay in one place.
//
// Docs read 26 Oct 2026: https://resend.com/docs/api-reference/emails/send-email
// (POST /emails; from, to, subject required; Idempotency-Key header, unique
// per request, max 256 characters, expires after 24 hours). Because Resend
// de-duplicates by key, ambiguous failures (timeouts, 5xx) are safe to retry
// with the same OutboundMessage.idempotencyKey within 24 hours.
//
// Mock mode (the default) records to the shared mock outbox and never calls
// Resend.

import { createHash } from "node:crypto";
import { isValidEmailAddress } from "@/lib/email/identity";
import { sendTransactionalEmail, TransactionalEmailDeliveryError } from "@/lib/email/resend";
import type { MessageChannel, OutboundMessage, SendResult } from "./channel";
import { getMessagingMode, type MessagingMode } from "./config";
import { createMockChannel } from "./mock";
import { configurationRequired, sendFailure, sendSuccess } from "./results";

export type ResendEmailChannelOptions = {
  /** Defaults to MESSAGING_MODE (mock unless `live`). */
  mode?: MessagingMode;
  /** Injectable for tests; defaults to sendTransactionalEmail. */
  send?: typeof sendTransactionalEmail;
};

const RESEND_IDEMPOTENCY_KEY_MAX = 256;
const NOT_CONFIGURED_CODES = new Set(["email_not_configured", "invoice_email_not_configured", "missing_api_key", "invalid_api_key", "restricted_api_key"]);

/** Scopes the caller's key to the garage (Resend keys are account-wide) and keeps it within Resend's limit. */
export function resendIdempotencyKey(garageId: string, key: string) {
  const scoped = `autofix:${garageId}:${key}`;
  if (scoped.length <= RESEND_IDEMPOTENCY_KEY_MAX) return scoped;
  return `autofix:sha256:${createHash("sha256").update(scoped).digest("hex")}`;
}

function subjectFor(message: OutboundMessage) {
  const subject = message.subject?.trim();
  if (subject) return subject;
  const firstLine = message.body.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 78 ? `${firstLine.slice(0, 77)}…` : firstLine || "Message";
}

function mapEmailError(error: unknown): SendResult {
  if (error instanceof TransactionalEmailDeliveryError) {
    if (NOT_CONFIGURED_CODES.has(error.code)) return configurationRequired(error.code);
    if (error.code === "invalid_recipient_or_sender") return sendFailure("invalid_recipient", false, { providerCode: error.code });
    if (error.code === "rate_limit_exceeded") return sendFailure("rate_limited", true, { providerCode: error.code });
    return sendFailure("provider_error", error.retryable, { providerCode: error.code, ambiguous: error.kind === "ambiguous" });
  }
  // Network failure before a response: retrying with the same idempotency key is safe.
  return sendFailure("provider_error", true, { providerCode: "network", ambiguous: true });
}

export function createResendEmailChannel(options: ResendEmailChannelOptions = {}): MessageChannel {
  const mode = options.mode ?? getMessagingMode();
  if (mode === "mock") return createMockChannel("email");
  const send = options.send ?? sendTransactionalEmail;

  return {
    kind: "email",
    mode: "live",
    async send(message) {
      if (!isValidEmailAddress(message.to)) return sendFailure("invalid_recipient", false, { providerCode: "invalid_email" });
      if (!message.body.trim() && !message.html?.trim()) return sendFailure("provider_error", false, { providerCode: "body_empty" });

      try {
        const result = await send({
          to: message.to,
          subject: subjectFor(message),
          text: message.body,
          html: message.html,
          idempotencyKey: message.idempotencyKey ? resendIdempotencyKey(message.garageId, message.idempotencyKey) : undefined,
          tags: /^[A-Za-z0-9_-]{1,256}$/.test(message.garageId) ? [{ name: "garage_id", value: message.garageId }] : undefined,
        });
        const id = result.data?.id;
        if (!id) return sendFailure("provider_error", true, { providerCode: "unexpected_response", ambiguous: true });
        return sendSuccess(id, "sent");
      } catch (error) {
        return mapEmailError(error);
      }
    },
  };
}
