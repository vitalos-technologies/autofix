import "server-only";

import { Resend } from "resend";
import { formatMailbox, isValidEmailAddress, mailboxAddress, parseEmailAddress } from "@/lib/email/identity";
import { getEnquiryReplyDomain } from "@/lib/enquiries/inbound-config";

export type TransactionalEmail = {
  /**
   * Display name for the From header, normally the garage's name. The address
   * is always the platform sender (RESEND_FROM_EMAIL); callers cannot choose it.
   */
  senderName?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Normally the garage's own address. Falls back to RESEND_REPLY_TO when omitted. */
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  idempotencyKey?: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

export type TransactionalEmailFailureKind = "rejected" | "ambiguous";

export class TransactionalEmailDeliveryError extends Error {
  constructor(
    readonly kind: TransactionalEmailFailureKind,
    readonly code: string,
    readonly retryable: boolean,
    message = `Email delivery failed: ${code}`,
  ) {
    super(message);
    this.name = "TransactionalEmailDeliveryError";
  }
}

export type ResendConfiguration = {
  apiKey: string;
  /** RESEND_FROM_EMAIL as configured, e.g. `Autofix <notifications@autofix.vitalos.co.uk>`. */
  from: string;
  /** The bare platform sender address. */
  fromAddress: string;
  /** Platform fallback reply-to (RESEND_REPLY_TO), used when a garage has no email address. */
  replyTo: string | null;
};

/** Resend settings from the environment, or null when email is not configured. */
export function getResendConfig(): ResendConfiguration | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  const fromAddress = mailboxAddress(from);
  const replyTo = process.env.RESEND_REPLY_TO?.trim() || null;
  if (!apiKey || !from || !fromAddress) return null;
  if (replyTo && !isValidEmailAddress(replyTo)) return null;
  return { apiKey, from, fromAddress, replyTo };
}

/** Invoice email uses the same platform identity as every other message. */
export function getInvoiceResendConfig() {
  return getResendConfig();
}

export async function sendTransactionalEmail(message: TransactionalEmail) {
  const config = getResendConfig();
  if (!config) throw new TransactionalEmailDeliveryError("rejected", "email_not_configured", false, "Transactional email is not configured");
  return sendWithConfig(config, message);
}

export async function sendInvoiceTransactionalEmail(message: TransactionalEmail) {
  const config = getInvoiceResendConfig();
  if (!config) throw new TransactionalEmailDeliveryError("rejected", "invoice_email_not_configured", false, "Invoice email is not configured");
  return sendWithConfig(config, message);
}

/** The From header for a message: the garage's name on the platform address. */
export function senderFor(config: Pick<ResendConfiguration, "from" | "fromAddress">, senderName?: string) {
  return senderName ? formatMailbox(senderName, config.fromAddress) : config.from;
}

async function sendWithConfig(config: ResendConfiguration, message: TransactionalEmail) {
  let to: string;
  let replyTo: string | undefined;
  let from: string;
  try {
    to = parseEmailAddress(message.to);
    const requestedReplyTo = message.replyTo ?? config.replyTo ?? undefined;
    replyTo = requestedReplyTo ? parseEmailAddress(requestedReplyTo) : undefined;
    from = senderFor(config, message.senderName);
  } catch {
    throw new TransactionalEmailDeliveryError("rejected", "invalid_recipient_or_sender", false);
  }

  const result = await new Resend(config.apiKey).emails.send({
    from,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(replyTo ? { replyTo } : {}),
    headers: message.headers,
    tags: message.tags,
    attachments: message.attachments,
  }, message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined);
  if (result.error) throw classifyTransactionalEmailProviderError(result.error);
  return result;
}

export function classifyTransactionalEmailProviderError(error: { name: string; statusCode: number | null }) {
  const code = /^[a-z0-9_]+$/.test(error.name) ? error.name : "provider_error";
  if (code === "invalid_idempotent_request") {
    return new TransactionalEmailDeliveryError("ambiguous", code, false);
  }
  if (error.statusCode === null || error.statusCode === 408 || error.statusCode >= 500 || code === "concurrent_idempotent_requests") {
    return new TransactionalEmailDeliveryError("ambiguous", code, true);
  }
  const retryable = code === "rate_limit_exceeded";
  return new TransactionalEmailDeliveryError("rejected", code, retryable);
}

export function getResendInboundConfig() {
  const replyConfig = getResendReplyConfig();
  const webhookConfig = getResendWebhookConfig();
  if (!replyConfig || !webhookConfig) return null;
  return { ...replyConfig, webhookSecret: webhookConfig.webhookSecret };
}

export function getResendWebhookConfig() {
  const base = getResendConfig();
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!base || !webhookSecret) return null;
  return { ...base, webhookSecret };
}

export function getResendReplyConfig() {
  const base = getResendConfig();
  const inboundDomain = getEnquiryReplyDomain();
  if (!base || !inboundDomain) return null;
  return { ...base, inboundDomain };
}

export function verifyResendWebhook(payload: string, headers: { id: string; timestamp: string; signature: string }) {
  const config = getResendWebhookConfig();
  if (!config) throw new Error("Resend delivery webhooks are not configured");
  return new Resend(config.apiKey).webhooks.verify({ payload, headers, webhookSecret: config.webhookSecret });
}

export async function retrieveReceivedEmail(emailId: string) {
  const config = getResendReplyConfig();
  if (!config) throw new Error("Legacy Resend inbound email is not configured");
  const result = await new Resend(config.apiKey).emails.receiving.get(emailId, { html_format: "cid" });
  if (result.error || !result.data) throw new Error("Received email content could not be retrieved");
  return result.data;
}

export async function retrieveSentEmail(emailId: string) {
  const config = getResendConfig();
  if (!config) throw new Error("Transactional email is not configured");
  const result = await new Resend(config.apiKey).emails.get(emailId);
  if (result.error || !result.data) throw new Error("Sent email metadata could not be retrieved");
  return result.data;
}
