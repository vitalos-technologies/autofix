import { createHmac, timingSafeEqual } from "node:crypto";

const lifetimeSeconds = 15 * 60;

function secret() {
  return process.env.SUPABASE_SECRET_KEY || process.env.CRON_SECRET || "local-development-secret";
}

/** The signature covers the garage too, so the token only works on the garage's own host. */
function sign(garageId: string, enquiryId: string, expires: string) {
  return createHmac("sha256", secret()).update(`enquiry-upload:${garageId}:${enquiryId}.${expires}`).digest("base64url");
}

export function createUploadToken(enquiryId: string, garageId: string) {
  const expires = String(Math.floor(Date.now() / 1000) + lifetimeSeconds);
  return `${enquiryId}.${expires}.${sign(garageId, enquiryId, expires)}`;
}

export function verifyUploadToken(token: string | null, enquiryId: string, garageId: string) {
  if (!token) return false;
  const [id, expiresValue, provided, extra] = token.split(".");
  if (!id || !expiresValue || !provided || extra !== undefined || id !== enquiryId) return false;
  const expires = Number(expiresValue);
  if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
  const expectedBuffer = Buffer.from(sign(garageId, id, expiresValue));
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}
