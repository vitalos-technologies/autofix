import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as adminConfig from "@/config/admin";
import { GARAGE_ADMIN_BASE_PATH, isGarageAdminPath } from "@/config/admin";
import { tenancyMigration } from "./support/migrations";

describe("garage admin access", () => {
  it("has no email allowlist: access is garage membership", () => {
    expect(Object.keys(adminConfig).sort()).toEqual(["GARAGE_ADMIN_BASE_PATH", "isGarageAdminPath"]);
    const login = readFileSync(join(process.cwd(), "src/app/app/login/actions.ts"), "utf8");
    expect(login).toContain("loadMemberships");
    expect(login).not.toMatch(/isAllowedAdminEmail|ADMIN_EMAILS?\b|@gmail\.com/);
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

  it("authorises database access by garage membership, not an email allowlist, and keeps the MFA rule", () => {
    expect(tenancyMigration).toContain("drop trigger enforce_allowed_admin_email on public.admin_profiles;");
    expect(tenancyMigration).toContain("drop function public.enforce_allowed_admin_email();");
    expect(tenancyMigration).toContain("drop function public.is_admin();");
    expect(tenancyMigration).not.toMatch(/sobautofix@gmail\.com|temitopeagbola@gmail\.com/);
    expect(tenancyMigration).toContain("public.garage_role(requested.garage_id) is not null");
    expect(tenancyMigration).toContain("coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'");
  });
});
