// Mock MessageChannel and the shared in-memory outbox.
//
// Mock channels never contact a provider. Every accepted send is recorded in
// one outbox shared by all mock channels in the process (kept on globalThis so
// it survives dev hot reloads and is shared across route handlers), so unit
// and end-to-end tests can assert on what would have been sent.
//
// Validation mirrors the live adapters (E.164 / email recipient, alphanumeric
// sender, body length) and Twilio's test-credential magic To numbers
// (https://www.twilio.com/docs/iam/test-credentials, read 26 Oct 2026), so
// failure paths can be exercised without injecting errors:
//   +15005550001 invalid (21211), +15005550002 cannot route (21612),
//   +15005550003 no region permission (21408), +15005550004 opted out (21610),
//   +15005550009 not a mobile (21614).
// The same idempotency key for the same channel and garage is recorded once
// and returns the first result.
//
// Provider ids are `SMmock<8-digit sequence><16 hex>` (`mock_email_…` for
// email): the sequence restarts with every process, so a random part keeps
// them unique in messages.provider_msg_id across restarts (DECISIONS A56).

import { isValidEmailAddress } from "@/lib/email/identity";
import type { ChannelKind, DeliveryStatus, MessageChannel, OutboundMessage, SendResult, WhatsAppTemplate } from "./channel";
import { isE164 } from "./phone";
import { bodyProblem, configurationRequired, isValidAlphanumericSenderId, sendFailure, sendSuccess } from "./results";

export type MockOutboxEntry = {
  kind: ChannelKind;
  garageId: string;
  to: string;
  body: string;
  subject?: string;
  html?: string;
  replyTo?: string;
  senderId?: string;
  statusCallbackUrl?: string;
  idempotencyKey: string;
  whatsappTemplate?: WhatsAppTemplate;
  providerMessageId: string;
  status: DeliveryStatus;
  createdAt: Date;
};

type MockStore = { entries: MockOutboxEntry[]; sequence: number };

const STORE_KEY = "__autofixMessagingMockOutbox";

function store(): MockStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: MockStore };
  holder[STORE_KEY] ??= { entries: [], sequence: 0 };
  return holder[STORE_KEY];
}

/** Every mock send so far, oldest first (a copy; mutate it freely). */
export function getMockOutbox(): MockOutboxEntry[] {
  return store().entries.map((entry) => ({ ...entry }));
}

export function clearMockOutbox() {
  const current = store();
  current.entries = [];
  current.sequence = 0;
}

const TWILIO_MAGIC_TO: Record<string, { code: number; httpStatus: number }> = {
  "+15005550001": { code: 21211, httpStatus: 400 },
  "+15005550002": { code: 21612, httpStatus: 400 },
  "+15005550003": { code: 21408, httpStatus: 400 },
  "+15005550004": { code: 21610, httpStatus: 400 },
  "+15005550009": { code: 21614, httpStatus: 400 },
};

// Mirrors twilio.ts mapTwilioError for the magic numbers without importing the server-only adapter.
function magicNumberFailure(to: string): SendResult | null {
  const magic = TWILIO_MAGIC_TO[to];
  if (!magic) return null;
  if (magic.code === 21610) return sendFailure("opted_out", false, { providerCode: magic.code });
  if (magic.code === 21408) return configurationRequired(magic.code);
  return sendFailure("invalid_recipient", false, { providerCode: magic.code });
}

function validate(kind: ChannelKind, message: OutboundMessage): { to: string } | SendResult {
  if (kind === "email") {
    if (!isValidEmailAddress(message.to)) return sendFailure("invalid_recipient", false, { providerCode: "invalid_email" });
    if (!message.body.trim() && !message.html?.trim()) return sendFailure("provider_error", false, { providerCode: "body_empty" });
    return { to: message.to };
  }

  const to = kind === "whatsapp" ? message.to.trim().replace(/^whatsapp:/i, "") : message.to;
  if (!isE164(to)) return sendFailure("invalid_recipient", false, { providerCode: "invalid_e164" });
  if (kind === "sms" && message.senderId !== undefined && !isValidAlphanumericSenderId(message.senderId)) {
    return configurationRequired("invalid_sender_id");
  }
  const template = kind === "whatsapp" ? message.whatsappTemplate : undefined;
  if (template && !/^HX[0-9a-fA-F]{32}$/.test(template.contentSid)) return configurationRequired("invalid_content_sid");
  const problem = bodyProblem(message.body, Boolean(template));
  if (problem) return problem;
  return magicNumberFailure(to) ?? { to };
}

function providerIdPrefix(kind: ChannelKind) {
  return kind === "email" ? "mock_email_" : "SMmock";
}

/** 16 random hex characters (Web Crypto, so this stays free of Node imports). */
function randomSuffix() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True for ids this mock outbox hands out. */
export function isMockProviderMessageId(value: string) {
  return /^(?:SMmock|mock_email_)\d{8}[0-9a-f]{16}$/.test(value);
}

export function createMockChannel(kind: ChannelKind): MessageChannel {
  return {
    kind,
    mode: "mock",
    async send(message) {
      const outbox = store();
      if (message.idempotencyKey) {
        const previous = outbox.entries.find(
          (entry) => entry.kind === kind && entry.garageId === message.garageId && entry.idempotencyKey === message.idempotencyKey,
        );
        if (previous) return sendSuccess(previous.providerMessageId, previous.status);
      }

      const checked = validate(kind, message);
      if ("ok" in checked) return checked;

      outbox.sequence += 1;
      const providerMessageId = `${providerIdPrefix(kind)}${outbox.sequence.toString().padStart(8, "0")}${randomSuffix()}`;
      const status: DeliveryStatus = kind === "email" ? "sent" : "queued";
      outbox.entries.push({
        kind,
        garageId: message.garageId,
        to: checked.to,
        body: message.body,
        subject: message.subject,
        html: message.html,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        senderId: message.senderId,
        statusCallbackUrl: message.statusCallbackUrl,
        idempotencyKey: message.idempotencyKey,
        whatsappTemplate: message.whatsappTemplate,
        providerMessageId,
        status,
        createdAt: new Date(),
      });
      return sendSuccess(providerMessageId, status);
    },
  };
}
