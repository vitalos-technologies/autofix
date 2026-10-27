import { createHash, randomBytes } from "node:crypto";

// Staff invite links (P4.4): `/signup/invite/<token>` on the admin host. The token is 32 random
// bytes, base64url (43 characters); only its hex SHA-256 is stored (`garage_invites.token_hash`),
// so a database read cannot rebuild a link. The link is shown once to whoever sends the invite.

export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** httpOnly cookie that carries the token from the link to the accept page (the address keeps no token). */
export const INVITE_COOKIE = "af_invite";
export const INVITE_COOKIE_MAX_AGE = 60 * 60;

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN_PATTERN.test(value);
}

export function inviteUrl(token: string, adminBase: string): string {
  return new URL(`/signup/invite/${token}`, `${adminBase}/`).toString();
}
