import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentTool } from "@/lib/agent-api/schemas";

// Agent service tokens (docs/autofix/ARCHITECTURE.md → Agent tool API).
//
// Raw token: `afat_` + 32 random bytes base64url. Stored only as
// hex HMAC-SHA-256(AGENT_TOKEN_PEPPER, raw token) in agent_tokens.token_hash,
// so a database leak alone cannot be replayed. The raw value is shown once,
// when it is issued, and never logged.

export const AGENT_TOKEN_PREFIX = "afat_";
const TOKEN_PATTERN = /^afat_[A-Za-z0-9_-]{43}$/;
const DEV_PEPPER = "local-agent-token-pepper-not-for-production";
export const AGENT_TOKEN_PEPPER_MIN_LENGTH = 32;

export class AgentTokenConfigError extends Error {
  constructor() {
    super("AGENT_TOKEN_PEPPER is not configured");
    this.name = "AgentTokenConfigError";
  }
}

/** The pepper; a fixed local value outside production, never a fallback in production. */
export function agentTokenPepper(env: Readonly<Record<string, string | undefined>> = process.env) {
  const pepper = env.AGENT_TOKEN_PEPPER?.trim();
  if (pepper && pepper.length >= AGENT_TOKEN_PEPPER_MIN_LENGTH) return pepper;
  if (env.NODE_ENV !== "production") return DEV_PEPPER;
  throw new AgentTokenConfigError();
}

export function generateAgentToken() {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isWellFormedAgentToken(token: string) {
  return TOKEN_PATTERN.test(token);
}

/** What is stored in `agent_tokens.token_hash`. */
export function hashAgentToken(token: string, pepper = agentTokenPepper()) {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

/** Constant-time comparison of two hex hashes. */
export function agentTokenHashesMatch(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token from `Authorization: Bearer <token>`, or null when absent or malformed. */
export function bearerToken(header: string | null | undefined) {
  if (!header || header.length > 200) return null;
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header.trim());
  const token = match?.[1];
  return token && isWellFormedAgentToken(token) ? token : null;
}

export function tokenAllows(scopes: readonly string[], tool: AgentTool) {
  return scopes.includes(tool);
}
