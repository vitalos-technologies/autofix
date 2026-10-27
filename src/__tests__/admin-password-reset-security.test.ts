import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getAdminContext: vi.fn(),
  loadMemberships: vi.fn(),
  recordUserSecurityEvent: vi.fn(async () => true),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  consumeRateLimit: vi.fn(),
  createClient: vi.fn(),
  revokeAllTrustedDevices: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: harness.redirect }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "192.0.2.1" })),
  cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn() })),
}));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: harness.consumeRateLimit }));
vi.mock("@/lib/auth/trusted-device-server", () => ({
  getCurrentTrustedDevice: vi.fn(),
  revokeAllTrustedDevices: harness.revokeAllTrustedDevices,
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
  createClient: harness.createClient,
}));
vi.mock("@/lib/tenancy/admin", () => ({
  GARAGE_COOKIE: "af_garage",
  GARAGE_COOKIE_OPTIONS: { httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 60 },
  getAdminContext: harness.getAdminContext,
  loadMemberships: harness.loadMemberships,
}));
vi.mock("@/lib/admin/audit", () => ({ recordUserSecurityEvent: harness.recordUserSecurityEvent }));

import { loginWithPassword, resetAdminPassword } from "@/app/app/login/actions";
import ResetPasswordPage from "@/app/app/reset-password/page";

function passwordForm() {
  const formData = new FormData();
  formData.set("password", "a-strong-new-password");
  formData.set("confirmPassword", "a-strong-new-password");
  return formData;
}

function adminAt(
  currentLevel: "aal1" | "aal2",
  method: "password" | "recovery" | "otp",
  nextLevel: "aal1" | "aal2" = currentLevel,
) {
  return {
    user: { id: "admin-id", email: "owner@hartleyroad.example" },
    profile: { user_id: "admin-id", display_name: "Admin" },
    assurance: {
      currentLevel,
      nextLevel,
      currentAuthenticationMethods: [{ method }],
    },
    client: { auth: { updateUser: harness.updateUser, signOut: harness.signOut } },
  };
}

describe("admin password reset authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.updateUser.mockResolvedValue({ error: null });
    harness.signOut.mockResolvedValue({ error: null });
    harness.consumeRateLimit.mockResolvedValue(true);
    harness.revokeAllTrustedDevices.mockResolvedValue(true);
  });

  it("throttles password attempts before calling Supabase Auth", async () => {
    harness.consumeRateLimit.mockResolvedValueOnce(false);
    const formData = new FormData();
    formData.set("email", "owner@hartleyroad.example");
    formData.set("password", "guessed-password");
    await expect(loginWithPassword({ message: "" }, formData)).resolves.toEqual({
      message: "Sign-in failed. Check your details and try again.",
    });
    expect(harness.createClient).not.toHaveBeenCalled();
  });

  it("signs out a correct password that belongs to no garage", async () => {
    const authSignOut = vi.fn(async () => ({ error: null }));
    harness.createClient.mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn(async () => ({ data: { user: { id: "stranger-id" } }, error: null })),
        signOut: authSignOut,
        mfa: { getAuthenticatorAssuranceLevel: vi.fn() },
      },
    });
    harness.loadMemberships.mockResolvedValue([]);
    const formData = new FormData();
    formData.set("email", "customer@example.test");
    formData.set("password", "correct-password");
    await expect(loginWithPassword({ message: "" }, formData)).resolves.toEqual({
      message: "This account is not linked to a garage. Ask the garage owner to invite you.",
    });
    expect(authSignOut).toHaveBeenCalledOnce();
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it("denies anonymous and ordinary AAL1 direct action calls", async () => {
    harness.getAdminContext.mockResolvedValueOnce(null);
    await expect(resetAdminPassword({ message: "" }, passwordForm())).resolves.toEqual({
      message: "This reset link is invalid or has expired. Request a new link.",
    });

    harness.getAdminContext.mockResolvedValueOnce(adminAt("aal1", "password"));
    await expect(resetAdminPassword({ message: "" }, passwordForm())).resolves.toEqual({
      message: "This reset link is invalid or has expired. Request a new link.",
    });
    expect(harness.updateUser).not.toHaveBeenCalled();
  });

  it("preserves the reset destination through a genuine MFA step-up", async () => {
    harness.getAdminContext.mockResolvedValue(adminAt("aal1", "otp", "aal2"));

    await expect(ResetPasswordPage()).rejects.toThrow(
      "NEXT_REDIRECT:/app/mfa?returnTo=%2Fapp%2Freset-password&stepUp=1",
    );
    expect(harness.getAdminContext).toHaveBeenCalledWith({ requireMfa: false });
  });

  it("does not let an ordinary AAL1 session open the reset form", async () => {
    harness.getAdminContext.mockResolvedValue(adminAt("aal1", "password"));

    await expect(ResetPasswordPage()).rejects.toThrow(
      "NEXT_REDIRECT:/app/login?error=invalid-link",
    );
  });

  it("renders the reset form after the MFA session reaches AAL2", async () => {
    harness.getAdminContext.mockResolvedValue(adminAt("aal2", "otp", "aal2"));

    await expect(ResetPasswordPage()).resolves.toBeTruthy();
  });

  it("allows a genuine recovery session and invalidates remembered access", async () => {
    harness.getAdminContext.mockResolvedValue(adminAt("aal1", "recovery"));
    await expect(resetAdminPassword({ message: "" }, passwordForm())).rejects.toThrow(
      "NEXT_REDIRECT:/app/login?reset=success",
    );
    expect(harness.updateUser).toHaveBeenCalledWith({ password: "a-strong-new-password" });
    expect(harness.revokeAllTrustedDevices).toHaveBeenCalledWith(
      "admin-id",
      "mfa_trusted_devices_revoked_password_change",
    );
    expect(harness.signOut).toHaveBeenCalled();
    expect(harness.recordUserSecurityEvent).toHaveBeenCalledWith("admin-id", "password_changed");
  });

  it("allows a current AAL2 administrator session", async () => {
    harness.getAdminContext.mockResolvedValue(adminAt("aal2", "password"));
    await expect(resetAdminPassword({ message: "" }, passwordForm())).rejects.toThrow(
      "NEXT_REDIRECT:/app/login?reset=success",
    );
    expect(harness.updateUser).toHaveBeenCalledOnce();
  });
});
