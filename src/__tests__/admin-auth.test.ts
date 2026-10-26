import { describe, expect, it } from "vitest";
import { ADMIN_EMAIL, ADMIN_EMAILS, isAllowedAdminEmail } from "@/config/admin";
import { tenancyMigration } from "./support/migrations";

describe("administrator identities", () => {
  it("allows only the configured SOB Autofix administrator emails", () => {
    expect(ADMIN_EMAIL).toBe("sobautofix@gmail.com");
    expect(ADMIN_EMAILS).toEqual([
      "sobautofix@gmail.com",
      "temitopeagbola@gmail.com",
    ]);
    expect(isAllowedAdminEmail("SOBAutofix@gmail.com")).toBe(true);
    expect(isAllowedAdminEmail(" TemitopeAgbola@gmail.com ")).toBe(true);
    expect(isAllowedAdminEmail("another@example.com")).toBe(false);
    expect(isAllowedAdminEmail(undefined)).toBe(false);
  });

  it("authorises database access by garage membership, not an email allowlist, and keeps the MFA rule", () => {
    expect(tenancyMigration).toContain("drop trigger enforce_allowed_admin_email on public.admin_profiles;");
    expect(tenancyMigration).toContain("drop function public.enforce_allowed_admin_email();");
    expect(tenancyMigration).toContain("drop function public.is_admin();");
    expect(tenancyMigration).not.toMatch(/sobautofix@gmail\.com|temitopeagbola@gmail\.com/);
    expect(tenancyMigration).toContain("public.garage_role(requested.garage_id) is not null");
    expect(tenancyMigration).toContain("coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'");
  });
});
