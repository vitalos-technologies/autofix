import { createHash, randomBytes } from "node:crypto";

// Pay-link tokens (P5.4). A link is `https://<garage host>/pay/<token>`: 32 random bytes, base64url.
// Only the SHA-256 is stored (payments.token_hash), so a database read never yields a working link.
// The /pay/<token> route moves the token into the httpOnly `af_pay` cookie and redirects to /pay, so
// the token never stays in the address bar, history or a Referer (Referrer-Policy: no-referrer).

export const PAY_COOKIE = "af_pay";
export const PAY_COOKIE_PATH = "/pay";
/** The cookie lives as long as a deposit hold can, and longer than a customer takes to pay. */
export const PAY_COOKIE_MAX_AGE_S = 4 * 60 * 60;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function createPayToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashPayToken(token) };
}

export function isPayTokenShape(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function hashPayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function payCookieOptions(maxAge = PAY_COOKIE_MAX_AGE_S) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: PAY_COOKIE_PATH,
    maxAge,
  };
}
