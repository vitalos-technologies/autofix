import { createHmac, timingSafeEqual } from "node:crypto";

// X-Twilio-Signature: base64 HMAC-SHA1 (auth token) over the full URL plus the sorted POST parameters
// (none on a WebSocket upgrade). Answerd's relay checks the same on its upgrade
// (workforce: modules/marketplace/src/realtime/server.ts); here it is an extra check on top of the claim.

export function twilioSignature(authToken: string, url: string, params: Record<string, string> = {}) {
  const data = url + Object.keys(params).sort().map((key) => key + params[key]).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

/** True when `signature` matches the URL as Twilio saw it (wss:// or https:// form). */
export function twilioSignatureValid(authToken: string, urls: string[], signature: string | undefined) {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return urls.some((url) => {
    const expected = Buffer.from(twilioSignature(authToken, url));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
