import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AccountingError } from "./types";

// AES-256-GCM for OAuth tokens at rest (accounting_connection_secrets) and for the short-lived OAuth
// state cookie (P5.10). The key is ACCOUNTING_TOKEN_KEY: 32 bytes as base64/base64url (44/43 chars)
// or hex (64 chars). It never goes in the database. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url),
// with associated data binding a token to its garage (and a cookie to its purpose), so ciphertext
// copied to another garage's row does not decrypt.
//
// Without a key, development and tests (NODE_ENV !== "production") use a fixed development key so
// the fake provider works out of the box (A368); production refuses (CONFIGURATION_REQUIRED).

const DEV_KEY_SEED = "autofix-development-accounting-token-key-not-for-production";

export function accountingKey(env: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  const raw = env.ACCOUNTING_TOKEN_KEY?.trim();
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) throw new AccountingError("CONFIGURATION_REQUIRED", { detail: "ACCOUNTING_TOKEN_KEY must be 32 bytes" });
    return key;
  }
  if (env.NODE_ENV === "production") throw new AccountingError("CONFIGURATION_REQUIRED", { detail: "ACCOUNTING_TOKEN_KEY" });
  return createHash("sha256").update(DEV_KEY_SEED).digest();
}

/** True when tokens can be encrypted in this environment. */
export function hasAccountingKey(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try {
    accountingKey(env);
    return true;
  } catch {
    return false;
  }
}

export function sealText(plaintext: string, associatedData: string, env?: Readonly<Record<string, string | undefined>>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", accountingKey(env), iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

/** Null when the value is malformed, was sealed with another key, or for other associated data. */
export function openText(sealed: string, associatedData: string, env?: Readonly<Record<string, string | undefined>>): string | null {
  const [version, ivText, tagText, dataText, ...rest] = sealed.split(".");
  if (version !== "v1" || ivText === undefined || tagText === undefined || dataText === undefined || rest.length) return null;
  try {
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", accountingKey(env), iv);
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof AccountingError) throw error;
    return null;
  }
}

/** Associated data for a garage's tokens. */
export function tokenAad(garageId: string): string {
  return `accounting-token:${garageId}`;
}
