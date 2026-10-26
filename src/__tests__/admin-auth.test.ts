import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_EMAIL, ADMIN_EMAILS, GARAGE_ADMIN_BASE_PATH, isAllowedAdminEmail, isGarageAdminPath } from "@/config/admin";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20260926213537_allow_multiple_admin_emails.sql"),
  "utf8",
);

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

  it("serves the garage admin from /app and leaves /admin for the super admin", () => {
    expect(GARAGE_ADMIN_BASE_PATH).toBe("/app");
    expect(isGarageAdminPath("/app")).toBe(true);
    expect(isGarageAdminPath("/app/enquiries/123")).toBe(true);
    expect(isGarageAdminPath("/application")).toBe(false);
    expect(isGarageAdminPath("/admin")).toBe(false);
    expect(isGarageAdminPath("/admin/enquiries")).toBe(false);
    expect(isGarageAdminPath("/api/admin/invoices/export")).toBe(false);
  });

  it("enforces the same allowlist and MFA policy in database authorization", () => {
    expect(migration).toContain("create or replace function public.is_admin()");
    expect(migration).toContain("'sobautofix@gmail.com'");
    expect(migration).toContain("'temitopeagbola@gmail.com'");
    expect(migration).toContain("auth.jwt() ->> 'aal', 'aal1') = 'aal2'");
    expect(migration).toContain("create trigger enforce_allowed_admin_email");
    expect(migration).toContain("revoke all on function public.enforce_allowed_admin_email() from public, anon, authenticated;");
  });
});
