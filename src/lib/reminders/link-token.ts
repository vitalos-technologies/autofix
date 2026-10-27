import "server-only";

import { createHash, randomBytes } from "node:crypto";

// Reminder link tokens (`/r/{token}`, P3.9): 16 random bytes (128 bits),
// base64url (22 characters), so a reminder with its link fits one text
// (DECISIONS A185). Links sent before that carry 32-byte, 43-character tokens
// and keep working until they expire. Only the SHA-256 hex goes into
// reminder_sends.link_token_hash, with an expiry 30 days after the send. The
// token itself is in the message the customer received and nowhere else:
// never logged, never stored.

export const REMINDER_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REMINDER_LINK_TOKEN_BYTES = 16;
/** New tokens (22 characters) and the 43-character ones sent before A185. */
export const REMINDER_LINK_TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/;

export type ReminderLinkToken = {
  token: string;
  /** SHA-256 of the token, 64 lower-case hex characters. */
  hash: string;
  expiresAt: Date;
};

export function hashReminderLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createReminderLinkToken(now: Date = new Date()): ReminderLinkToken {
  const token = randomBytes(REMINDER_LINK_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashReminderLinkToken(token), expiresAt: new Date(now.getTime() + REMINDER_LINK_TTL_MS) };
}

/** The path on the garage's booking host. */
export function reminderLinkPath(token: string) {
  return `/r/${token}`;
}

export function isReminderLinkToken(value: unknown): value is string {
  return typeof value === "string" && REMINDER_LINK_TOKEN_PATTERN.test(value);
}
