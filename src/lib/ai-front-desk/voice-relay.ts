import { createHmac, timingSafeEqual } from "node:crypto";

// Voice desk relay (P5.12 voice desk, DECISIONS AV1–AV10). Server only (node:crypto).
//
// A Pro garage's missed call is answered by Autofix's own voice service
// (services/voice, Azure Container App `autofix-voice`). The voice webhook
// speaks the disclosure, then `<Connect><ConversationRelay url=…>` points
// Twilio at the service's WebSocket with a signed, short-lived claim in the
// query string: garage id, CallSid, expiry, HMAC-SHA-256(VOICE_RELAY_SECRET).
// The service checks the claim, then trades it (with the same secret as a
// key) for a per-call agent token at POST /api/voice/v1/session. No caller
// number or registration is in the URL.
//
// services/voice/src/claim.ts implements the same claim; the shared test
// vector in both test suites keeps them in step.

export const VOICE_RELAY_ENV = { url: "VOICE_RELAY_URL", secret: "VOICE_RELAY_SECRET" } as const;
export const VOICE_RELAY_SECRET_MIN_LENGTH = 32;
/** How long the claim in the relay URL is good for: the disclosure plus a cold start, with room to spare. */
export const RELAY_CLAIM_TTL_SECONDS = 300;
/** The header the voice service sends VOICE_RELAY_SECRET in when it asks for a call's token. */
export const VOICE_SERVICE_KEY_HEADER = "x-autofix-voice-key";

export type VoiceRelayTarget = {
  /** wss://host/relay, no query. */
  url: string;
  /** https://host/healthz, fetched to wake the service while the disclosure plays. */
  healthUrl: string;
  secret: string;
};

export type RelayClaim = { garageId: string; callSid: string; expires: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;

export function parseVoiceRelayTarget(env: Readonly<Record<string, string | undefined>> = process.env): VoiceRelayTarget | null {
  const raw = env[VOICE_RELAY_ENV.url]?.trim();
  const secret = env[VOICE_RELAY_ENV.secret]?.trim();
  if (!raw || !secret || secret.length < VOICE_RELAY_SECRET_MIN_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "wss:" || url.search || url.hash || url.username || url.password) return null;
  const health = new URL(url.toString());
  health.protocol = "https:";
  health.pathname = "/healthz";
  return { url: url.toString(), healthUrl: health.toString(), secret };
}

function payload(claim: RelayClaim) {
  return `v1.${claim.garageId}.${claim.callSid}.${claim.expires}`;
}

export function signRelayClaim(secret: string, claim: RelayClaim) {
  return createHmac("sha256", secret).update(payload(claim)).digest("hex");
}

/** The ConversationRelay URL for one call: the service's /relay with the signed claim. */
export function relayConnectUrl(target: VoiceRelayTarget, input: { garageId: string; callSid: string; now?: Date }) {
  const expires = Math.floor((input.now ?? new Date()).getTime() / 1000) + RELAY_CLAIM_TTL_SECONDS;
  const claim: RelayClaim = { garageId: input.garageId, callSid: input.callSid, expires };
  const url = new URL(target.url);
  url.search = new URLSearchParams({ g: claim.garageId, c: claim.callSid, e: String(expires), s: signRelayClaim(target.secret, claim) }).toString();
  return url.toString();
}

/** The claim when the signature matches and it has not expired, else null. Constant-time comparison. */
export function verifyRelayClaim(secret: string, input: { garageId?: unknown; callSid?: unknown; expires?: unknown; signature?: unknown }, now: Date = new Date()): RelayClaim | null {
  const { garageId, callSid, signature } = input;
  const expires = typeof input.expires === "string" && /^\d{1,12}$/.test(input.expires) ? Number(input.expires) : input.expires;
  if (typeof garageId !== "string" || !UUID.test(garageId)) return null;
  if (typeof callSid !== "string" || !CALL_SID.test(callSid)) return null;
  if (typeof expires !== "number" || !Number.isSafeInteger(expires)) return null;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return null;
  if (expires * 1000 <= now.getTime() || expires * 1000 > now.getTime() + RELAY_CLAIM_TTL_SECONDS * 1000 + 60_000) return null;
  const claim = { garageId, callSid, expires };
  const expected = Buffer.from(signRelayClaim(secret, claim), "utf8");
  const given = Buffer.from(signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given) ? claim : null;
}

/** Constant-time check of the voice service's key (VOICE_RELAY_SECRET). */
export function voiceServiceKeyMatches(secret: string, given: string | null) {
  if (!given) return false;
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
