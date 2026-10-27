import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { faqsFromSettings } from "@/lib/agent-api/store";
import {
  AgentTokenConfigError,
  agentTokenHashesMatch,
  agentTokenPepper,
  bearerToken,
  generateAgentToken,
  hashAgentToken,
  isWellFormedAgentToken,
  tokenAllows,
} from "@/lib/agent-api/tokens";

const PEPPER = "p".repeat(32);

describe("agent tokens", () => {
  it("generates afat_ + 43 base64url characters, different every time", () => {
    const first = generateAgentToken();
    expect(first).toMatch(/^afat_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedAgentToken(first)).toBe(true);
    expect(generateAgentToken()).not.toBe(first);
  });

  it("stores HMAC-SHA-256 with the pepper, never the token or a bare hash", () => {
    const token = generateAgentToken();
    const hash = hashAgentToken(token, PEPPER);
    expect(hash).toBe(createHmac("sha256", PEPPER).update(token).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(token, "q".repeat(32))).not.toBe(hash);
  });

  it("compares hashes in constant time and refuses different lengths", () => {
    expect(agentTokenHashesMatch("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(agentTokenHashesMatch("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(agentTokenHashesMatch("a".repeat(64), "a".repeat(63))).toBe(false);
  });

  it("reads only well-formed bearer tokens", () => {
    const token = generateAgentToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    expect(bearerToken(token)).toBeNull();
    expect(bearerToken(`Basic ${token}`)).toBeNull();
    expect(bearerToken("Bearer afat_short")).toBeNull();
    expect(bearerToken(`Bearer ${token} extra`)).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it("needs a real pepper in production and falls back only in development", () => {
    expect(agentTokenPepper({ AGENT_TOKEN_PEPPER: PEPPER, NODE_ENV: "production" })).toBe(PEPPER);
    expect(() => agentTokenPepper({ NODE_ENV: "production" })).toThrow(AgentTokenConfigError);
    expect(() => agentTokenPepper({ AGENT_TOKEN_PEPPER: "short", NODE_ENV: "production" })).toThrow(AgentTokenConfigError);
    expect(agentTokenPepper({ NODE_ENV: "development" })).toMatch(/^local-/);
  });

  it("checks scopes by tool name", () => {
    expect(tokenAllows(["get_booking"], "get_booking")).toBe(true);
    expect(tokenAllows(["get_booking"], "create_booking")).toBe(false);
  });
});

describe("faqsFromSettings", () => {
  it("keeps complete {question, answer} pairs from garages.settings.faqs", () => {
    expect(faqsFromSettings({ faqs: [{ question: " Q1 ", answer: " A1 " }, { question: "Q2" }, "junk", null] })).toEqual([{ question: "Q1", answer: "A1" }]);
    expect(faqsFromSettings({})).toEqual([]);
    expect(faqsFromSettings(null)).toEqual([]);
  });
});
