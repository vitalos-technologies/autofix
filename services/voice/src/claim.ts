import { createHmac, timingSafeEqual } from "node:crypto";

// The relay claim Autofix puts in the ConversationRelay URL (src/lib/ai-front-desk/voice-relay.ts in the
// Autofix app, same algorithm, same shared test vector): ?g=<garage id>&c=<CallSid>&e=<unix expiry>&s=<hex
// HMAC-SHA-256(VOICE_RELAY_SECRET, "v1.<g>.<c>.<e>")>.

export type RelayClaim = { garageId: string; callSid: string; expires: number; signature: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
/** Autofix signs claims for 5 minutes; a minute of clock skew is allowed on top. */
const MAX_AHEAD_SECONDS = 360;

export function signClaim(secret: string, claim: Pick<RelayClaim, "garageId" | "callSid" | "expires">) {
  return createHmac("sha256", secret).update(`v1.${claim.garageId}.${claim.callSid}.${claim.expires}`).digest("hex");
}

/** The claim from a relay URL's query when its signature matches and it has not expired, else null. */
export function verifyClaim(secret: string, query: URLSearchParams, now: Date = new Date()): RelayClaim | null {
  const garageId = query.get("g") ?? "";
  const callSid = query.get("c") ?? "";
  const rawExpires = query.get("e") ?? "";
  const signature = query.get("s") ?? "";
  if (!UUID.test(garageId) || !CALL_SID.test(callSid) || !/^\d{1,12}$/.test(rawExpires) || !/^[0-9a-f]{64}$/.test(signature)) return null;
  const expires = Number(rawExpires);
  const nowSeconds = now.getTime() / 1000;
  if (expires <= nowSeconds || expires > nowSeconds + MAX_AHEAD_SECONDS) return null;
  const expected = Buffer.from(signClaim(secret, { garageId, callSid, expires }), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { garageId, callSid, expires, signature };
}
