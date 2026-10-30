import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getResendConfig, senderFor } from "@/lib/email/resend";

describe("platform sender and garage contact details", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends from one platform address with the garage's name as display name", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM_EMAIL", "Pitline <notifications@pitline.co.uk>");
    vi.stubEnv("RESEND_REPLY_TO", "");
    const config = getResendConfig();
    expect(config).toMatchObject({ fromAddress: "notifications@pitline.co.uk", replyTo: null });
    expect(senderFor(config!, "Hartley Road Motors")).toBe('"Hartley Road Motors" <notifications@pitline.co.uk>');
    expect(senderFor(config!)).toBe("Pitline <notifications@pitline.co.uk>");
  });

  it("refuses an unusable sender instead of guessing one", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM_EMAIL", "Pitline <not-an-address>");
    expect(getResendConfig()).toBeNull();
  });

  it("takes invoice issuer contact details from the garage instead of SOB defaults", () => {
    const migration = readFileSync("supabase/migrations/20261026000100_tenancy.sql", "utf8");
    expect(migration).toContain("alter column issuer_email drop default");
    expect(migration).toContain("coalesce(garage.email, '')");
    expect(migration).not.toContain("sobautofix.com");
  });

  it("documents the platform sender and reply domain without single-business values", () => {
    const env = readFileSync(".env.example", "utf8");
    expect(env).toContain("RESEND_FROM_EMAIL=Pitline <notifications@pitline.co.uk>");
    expect(env).toContain("ENQUIRY_REPLY_DOMAIN=reply.pitline.co.uk");
    expect(env).not.toContain("ENQUIRY_NOTIFICATION_EMAIL");
    expect(env).not.toMatch(/sobautofix/i);
  });
});
