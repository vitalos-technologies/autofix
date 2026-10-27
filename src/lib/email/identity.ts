import { z } from "zod";

// Email identity helpers. Autofix sends every message from one platform sender
// (RESEND_FROM_EMAIL) with the garage's name as the display name, and replies
// go to the garage's own address. No business addresses are hard-coded here.

const emailAddress = z.email();

export function parseEmailAddress(value: string) {
  return emailAddress.parse(value);
}

export function isValidEmailAddress(value: string | undefined | null) {
  return Boolean(value && emailAddress.safeParse(value).success);
}

export function resolveReplyTo(defaultReplyTo: string, requestedReplyTo?: string) {
  return parseEmailAddress(requestedReplyTo ?? defaultReplyTo);
}

/** The bare address of `Name <address>` or `address`, or null when it is not a valid address. */
export function mailboxAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const bracketed = /<([^<>\s]+)>\s*$/.exec(trimmed)?.[1] ?? trimmed;
  const candidate = bracketed.toLowerCase();
  return isValidEmailAddress(candidate) ? candidate : null;
}

/** A display name that is safe inside a From header (no quotes, brackets, separators or control characters). */
export function senderDisplayName(name: string | null | undefined, fallback = "Autofix") {
  const cleaned = Array.from(name ?? "")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || `"<>\\;,@`.includes(character) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  return cleaned || fallback;
}

/** `"Hartley Road Motors" <notifications@autofix.vitalos.co.uk>` */
export function formatMailbox(name: string, address: string) {
  return `"${senderDisplayName(name)}" <${parseEmailAddress(address)}>`;
}
