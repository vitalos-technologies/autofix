// Shared SendResult constructors. Kept apart from channel.ts so adapters do
// not import channel.ts at runtime (channel.ts imports the adapters).

import type { DeliveryStatus, SendFailure, SendFailureCode, SendSuccess } from "./channel";

export function sendSuccess(providerMessageId: string, status: DeliveryStatus): SendSuccess {
  return { ok: true, providerMessageId, status };
}

export function sendFailure(
  code: SendFailureCode,
  retryable: boolean,
  extras: Pick<SendFailure, "providerCode" | "retryAfterSeconds" | "ambiguous"> = {},
): SendFailure {
  const result: SendFailure = { ok: false, code, retryable };
  if (extras.providerCode !== undefined) result.providerCode = extras.providerCode;
  if (extras.retryAfterSeconds !== undefined) result.retryAfterSeconds = extras.retryAfterSeconds;
  if (extras.ambiguous) result.ambiguous = true;
  return result;
}

export function configurationRequired(providerCode?: string | number): SendFailure {
  return sendFailure("configuration_required", false, { providerCode });
}

/**
 * Alphanumeric SMS sender: 1 to 11 characters, at least one letter. Twilio's
 * UK guidelines recommend only A-Z, a-z, 0-9, space, period, dash, underscore
 * and ampersand (UK operators block other special characters).
 */
export function isValidAlphanumericSenderId(value: string) {
  return /^(?=.*[A-Za-z])[A-Za-z0-9 ._&-]{1,11}$/.test(value);
}

/** Body checks shared by mock and live SMS/WhatsApp channels. Twilio accepts up to 1,600 characters. */
export const MAX_BODY_LENGTH = 1600;

export function bodyProblem(body: string, hasTemplate = false): SendFailure | null {
  if (hasTemplate) return null;
  if (!body.trim()) return sendFailure("provider_error", false, { providerCode: "body_empty" });
  if (body.length > MAX_BODY_LENGTH) return sendFailure("provider_error", false, { providerCode: "body_too_long" });
  return null;
}
