import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  user: { id: "admin-id" } as { id: string } | null,
  assurance: { currentLevel: "aal1", nextLevel: "aal1" } as { currentLevel: string; nextLevel: string },
  trustedRecord: null as Record<string, unknown> | null,
  policy: null as Record<string, unknown> | null,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    const queryFor = (table: string) => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === "admin_mfa_policy" ? harness.policy : harness.trustedRecord, error: null }), update: () => query, is: () => query };
      return query;
    };
    return { from: (table: string) => queryFor(table) };
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: harness.user } })),
      mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: harness.assurance })) },
    },
  }),
}));

import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";

describe("admin MFA proxy enforcement", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-key";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    harness.user = { id: "admin-id" };
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal1" };
    harness.trustedRecord = null;
    harness.policy = { mandatory_mfa_enabled: false };
  });

  it("allows a direct protected request when no MFA factor is enrolled", async () => {
    const response = await proxy(new NextRequest("http://localhost/app/enquiries"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects a no-factor administrator to enrollment after mandatory MFA activation", async () => {
    harness.policy = { mandatory_mfa_enabled: true };
    const response = await proxy(new NextRequest("http://localhost/app/enquiries"));
    expect(response.headers.get("location")).toBe("http://localhost/app/mfa/enroll");
  });

  it("leaves onboarding to its own MFA step while enrolment is mandatory (P4.4)", async () => {
    harness.policy = { mandatory_mfa_enabled: true };
    const response = await proxy(new NextRequest("http://localhost/app/onboarding/security"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("still sends an enrolled but unverified session on onboarding pages to the challenge", async () => {
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2" };
    const response = await proxy(new NextRequest("http://localhost/app/onboarding/services"));
    expect(response.headers.get("location")).toBe("http://localhost/app/mfa?returnTo=%2Fapp%2Fonboarding%2Fservices");
  });

  it("blocks direct protected access until the enrolled factor is verified", async () => {
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2" };
    const response = await proxy(new NextRequest("http://localhost/app/enquiries?status=new"));
    expect(response.headers.get("location")).toBe("http://localhost/app/mfa?returnTo=%2Fapp%2Fenquiries%3Fstatus%3Dnew");
  });

  it("allows direct protected access after MFA verification", async () => {
    harness.assurance = { currentLevel: "aal2", nextLevel: "aal2" };
    const response = await proxy(new NextRequest("http://localhost/app/enquiries"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect the challenge page into a loop", async () => {
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2" };
    const response = await proxy(new NextRequest("http://localhost/app/mfa"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("allows ordinary navigation with a valid trusted-device token but still steps up for Security", async () => {
    const token = "a".repeat(64);
    const { hashTrustedDeviceToken, TRUSTED_DEVICE_COOKIE } = await import("@/lib/auth/trusted-device");
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2" };
    harness.trustedRecord = { id: "device-id", user_id: "admin-id", token_hash: await hashTrustedDeviceToken(token), device_label: "Chrome on Windows", user_agent_summary: null, created_at: new Date().toISOString(), last_used_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null };
    const headers = { cookie: `${TRUSTED_DEVICE_COOKIE}=${token}` };
    expect((await proxy(new NextRequest("http://localhost/app/enquiries", { headers }))).headers.get("location")).toBeNull();
    expect((await proxy(new NextRequest("http://localhost/app/configuration/security", { headers }))).headers.get("location")).toContain("/app/mfa");
  });
});

describe("proxy route matching", () => {
  it("runs on every route except build assets, so host routing covers /app, /auth and /admin", () => {
    // The second entry forwards the super admin's static files (src/lib/superadmin/proxy.ts).
    expect(config.matcher).toEqual([expect.any(String), "/superadmin/:path*"]);
    const pattern = new RegExp(`^${config.matcher[0]!.replace("/((?!", "/(?!(?:").replace(").*)", ")).*")}$`);
    for (const path of ["/app/enquiries", "/auth/confirm", "/admin", "/", "/service"]) expect(pattern.test(path)).toBe(true);
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/email/logo.png"]) expect(pattern.test(path)).toBe(false);
  });
});
