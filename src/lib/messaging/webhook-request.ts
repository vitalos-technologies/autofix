import "server-only";

import { readTwilioConfig, type MessagingEnv } from "./config";
import { parseTwilioForm, verifyTwilioSignature } from "./twilio";

// Reading a Twilio webhook: the raw form body, the public URL Twilio signed,
// and X-Twilio-Signature checked against both (docs read 26 Oct 2026:
// https://www.twilio.com/docs/usage/webhooks/webhooks-security).
//
// Behind Vercel or any other proxy the URL the app sees may not be the one
// Twilio called. TWILIO_WEBHOOK_BASE_URL (e.g. https://pitline.co.uk)
// pins the public origin (and an optional path prefix); without it the URL is
// rebuilt from X-Forwarded-Proto / X-Forwarded-Host (first value), then Host.
// Forged forwarding headers cannot help an attacker: the signature still
// needs the auth token. Twilio signatures carry no timestamp, so replays are
// stopped by idempotency (twilio_webhook_events), not here.

/** Twilio's webhook bodies are a few kilobytes; anything far larger is refused unread. */
export const MAX_TWILIO_BODY_BYTES = 64 * 1024;

function firstHeaderValue(value: string | null) {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
}

/** The URL Twilio signed: the configured public base (or forwarded origin) + the request's path and query. */
export function twilioWebhookUrl(request: Request, env: MessagingEnv = process.env): string {
  const url = new URL(request.url);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const configured = env.TWILIO_WEBHOOK_BASE_URL?.trim();
  if (configured) {
    try {
      const base = new URL(configured);
      if ((base.protocol === "https:" || base.protocol === "http:") && !base.username && !base.password) {
        return `${base.origin}${base.pathname.replace(/\/+$/, "")}${pathAndQuery}`;
      }
    } catch {
      // A malformed base falls back to the request's own origin (and signatures will say if it is wrong).
    }
  }
  const proto = firstHeaderValue(request.headers.get("x-forwarded-proto"))?.toLowerCase() ?? url.protocol.replace(/:$/, "");
  const host = firstHeaderValue(request.headers.get("x-forwarded-host")) ?? firstHeaderValue(request.headers.get("host")) ?? url.host;
  return `${proto === "http" ? "http" : "https"}://${host}${pathAndQuery}`;
}

export type VerifiedTwilioRequest =
  | { ok: true; form: Record<string, string>; rawBody: string }
  | { ok: false; status: 403 | 413 | 415 | 503; code: "invalid_signature" | "too_large" | "unsupported_media_type" | "not_configured" };

/** Reads the raw body once and checks the signature on it. Nothing is parsed or stored before the check passes. */
export async function readVerifiedTwilioRequest(request: Request, env: MessagingEnv = process.env): Promise<VerifiedTwilioRequest> {
  const authToken = readTwilioConfig(env).authToken;
  if (!authToken) return { ok: false, status: 503, code: "not_configured" };

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) return { ok: false, status: 415, code: "unsupported_media_type" };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_TWILIO_BODY_BYTES) return { ok: false, status: 413, code: "too_large" };

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_TWILIO_BODY_BYTES) return { ok: false, status: 413, code: "too_large" };

  const valid = verifyTwilioSignature({
    url: twilioWebhookUrl(request, env),
    params: new URLSearchParams(rawBody),
    signature: request.headers.get("x-twilio-signature"),
    authToken,
  });
  if (!valid) return { ok: false, status: 403, code: "invalid_signature" };
  return { ok: true, form: parseTwilioForm(rawBody), rawBody };
}

export { escapeXml } from "@/lib/calls/twiml";

/** A TwiML answer. `<Response/>` (the default) tells Twilio to do nothing more, e.g. send no auto-reply. */
export function twimlResponse(inner = "", status = 200) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** JSON error for requests Twilio did not sign (or that we cannot check). */
export function webhookErrorResponse(status: number, code: string) {
  return new Response(JSON.stringify({ code }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
