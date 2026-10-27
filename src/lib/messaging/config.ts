import "server-only";

// Messaging configuration from env. Reads names only into readiness output:
// values are never returned in readiness, logged or put in errors.
//
// MESSAGING_MODE=live turns on real providers; anything else (including
// unset) is mock. Malformed Twilio identifiers are treated as missing so a
// typo fails closed instead of producing provider errors.

import { getResendConfig } from "@/lib/email/resend";
import type { ChannelKind } from "./channel";

export type MessagingEnv = Record<string, string | undefined>;
export type MessagingMode = "mock" | "live";
export type ChannelReadiness = "mock" | "ready" | "configuration_required";

export type MessagingReadiness = {
  mode: MessagingMode;
  channels: Record<ChannelKind, ChannelReadiness>;
  /** Names of missing or malformed env vars (never their values). */
  missing: string[];
  /** Whether Twilio delivery callbacks will be requested. */
  statusCallbacks: "configured" | "not_configured";
};

export const TWILIO_STATUS_CALLBACK_PATH = "/api/webhooks/twilio/status";

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getMessagingMode(env: MessagingEnv = process.env): MessagingMode {
  return clean(env.MESSAGING_MODE)?.toLowerCase() === "live" ? "live" : "mock";
}

export type TwilioEnvConfig = {
  accountSid?: string;
  authToken?: string;
  messagingServiceSid?: string;
  /** E.164 without the `whatsapp:` prefix. */
  whatsappFrom?: string;
  statusCallbackUrl?: string;
};

function statusCallbackUrlFrom(base: string | undefined) {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${TWILIO_STATUS_CALLBACK_PATH}`;
  } catch {
    return undefined;
  }
}

export function readTwilioConfig(env: MessagingEnv = process.env): TwilioEnvConfig {
  const accountSid = clean(env.TWILIO_ACCOUNT_SID);
  const messagingServiceSid = clean(env.TWILIO_MESSAGING_SERVICE_SID);
  const whatsappFrom = clean(env.TWILIO_WHATSAPP_FROM)?.replace(/^whatsapp:/i, "");

  return {
    accountSid: accountSid && ACCOUNT_SID.test(accountSid) ? accountSid : undefined,
    authToken: clean(env.TWILIO_AUTH_TOKEN),
    messagingServiceSid: messagingServiceSid && MESSAGING_SERVICE_SID.test(messagingServiceSid) ? messagingServiceSid : undefined,
    whatsappFrom: whatsappFrom && E164.test(whatsappFrom) ? whatsappFrom : undefined,
    // Delivery receipts go to this app: TWILIO_STATUS_CALLBACK_BASE_URL if set, else the (https) site URL.
    statusCallbackUrl: statusCallbackUrlFrom(clean(env.TWILIO_STATUS_CALLBACK_BASE_URL) ?? clean(env.NEXT_PUBLIC_SITE_URL)),
  };
}

/** Email readiness comes from the existing Resend helper (process.env). */
export function readEmailReadiness(): "ready" | "configuration_required" {
  return getResendConfig() ? "ready" : "configuration_required";
}

/** For /api/health and the admin: what each channel will do, without exposing any value. */
export function getMessagingReadiness(env: MessagingEnv = process.env): MessagingReadiness {
  const mode = getMessagingMode(env);
  const twilio = readTwilioConfig(env);
  const statusCallbacks = twilio.statusCallbackUrl ? "configured" : "not_configured";

  if (mode === "mock") {
    return { mode, channels: { sms: "mock", whatsapp: "mock", email: "mock" }, missing: [], statusCallbacks };
  }

  const missing: string[] = [];
  if (!twilio.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!twilio.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!twilio.messagingServiceSid) missing.push("TWILIO_MESSAGING_SERVICE_SID");
  if (!twilio.whatsappFrom) missing.push("TWILIO_WHATSAPP_FROM");
  const email = readEmailReadiness();
  if (email !== "ready") missing.push("RESEND_*");

  const twilioCore = Boolean(twilio.accountSid && twilio.authToken);
  return {
    mode,
    channels: {
      sms: twilioCore && twilio.messagingServiceSid ? "ready" : "configuration_required",
      whatsapp: twilioCore && twilio.whatsappFrom ? "ready" : "configuration_required",
      email,
    },
    missing,
    statusCallbacks,
  };
}
