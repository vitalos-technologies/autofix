import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { openText, sealText } from "./crypto";
import { isAccountingProviderId, type AccountingProviderId } from "./types";

// OAuth 2 plumbing for the connect / callback route handlers (P5.10): PKCE (RFC 7636, S256), a
// random state, and the sealed, httpOnly, SameSite=Lax state cookie that carries them across the
// provider's consent page. The cookie also pins the garage and the user that started the flow; the
// callback checks both against the admin session (the garage never comes from the query string).

export const ACCOUNTING_OAUTH_COOKIE = "af_accounting_oauth";
export const ACCOUNTING_OAUTH_TTL_SECONDS = 10 * 60;
const COOKIE_AAD = "accounting-oauth-state";

export function accountingOAuthCookieOptions(env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    httpOnly: true,
    // Lax: the provider sends the browser back with a top-level GET, which must carry the cookie.
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/api/admin/accounting",
    maxAge: ACCOUNTING_OAUTH_TTL_SECONDS,
  };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export type OAuthState = {
  state: string;
  verifier: string;
  provider: AccountingProviderId;
  garageId: string;
  userId: string;
  /** Epoch ms. */
  expiresAt: number;
};

export function createOAuthState(input: { provider: AccountingProviderId; garageId: string; userId: string; now?: Date }): OAuthState {
  const now = input.now ?? new Date();
  return {
    state: randomToken(32),
    verifier: randomToken(48),
    provider: input.provider,
    garageId: input.garageId,
    userId: input.userId,
    expiresAt: now.getTime() + ACCOUNTING_OAUTH_TTL_SECONDS * 1000,
  };
}

export function sealOAuthState(state: OAuthState, env?: Readonly<Record<string, string | undefined>>): string {
  return sealText(JSON.stringify(state), COOKIE_AAD, env);
}

export function openOAuthState(sealed: string | undefined | null, env?: Readonly<Record<string, string | undefined>>): OAuthState | null {
  if (!sealed) return null;
  const text = openText(sealed, COOKIE_AAD, env);
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<OAuthState>;
    if (
      typeof value.state !== "string" ||
      typeof value.verifier !== "string" ||
      !isAccountingProviderId(value.provider) ||
      typeof value.garageId !== "string" ||
      typeof value.userId !== "string" ||
      typeof value.expiresAt !== "number"
    ) {
      return null;
    }
    return value as OAuthState;
  } catch {
    return null;
  }
}

export type CallbackProblem = "missing_state" | "state_mismatch" | "expired" | "wrong_provider" | "wrong_garage" | "wrong_user";

/** Checks the callback's `state` and the session against the sealed cookie. Null when all match. */
export function checkCallback(
  cookie: OAuthState | null,
  input: { state: string | null; provider: AccountingProviderId; garageId: string; userId: string; now?: Date },
): CallbackProblem | null {
  if (!cookie || !input.state) return "missing_state";
  const expected = Buffer.from(cookie.state, "utf8");
  const actual = Buffer.from(input.state, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return "state_mismatch";
  if (cookie.expiresAt < (input.now ?? new Date()).getTime()) return "expired";
  if (cookie.provider !== input.provider) return "wrong_provider";
  if (cookie.garageId !== input.garageId) return "wrong_garage";
  if (cookie.userId !== input.userId) return "wrong_user";
  return null;
}
