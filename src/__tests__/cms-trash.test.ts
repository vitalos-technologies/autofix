import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("CMS trash", () => {
  it("adds recoverable deletion metadata and a restricted, garage-scoped bulk management function", () => {
    const baseline = read("supabase/migrations/20261026000000_baseline.sql");
    const migration = read("supabase/migrations/20261026000100_tenancy.sql");
    for (const table of ["enquiries", "bookings", "invoices", "booking_service_types", "service_catalogue_systems"]) {
      expect(baseline).toMatch(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n  deleted_at timestamptz,`));
    }
    expect(migration).toContain("create or replace function public.manage_admin_trash");
    expect(migration).toContain("if not coalesce(public.garage_actor_allowed(), false) then\n    raise exception 'ADMIN_REQUIRED'");
    expect(migration).toContain("where garage_id = $3 and id = any($2) and deleted_at is null");
    expect(migration).toContain("status = 'draft'");
    expect(migration).toContain("grant execute on function public.manage_admin_trash(text, uuid[], text) to authenticated;");
  });

  it("shows a separated trash section for every record-based admin module", () => {
    const page = read("src/app/app/(protected)/trash/page.tsx");
    const actions = read("src/app/app/(protected)/trash/actions.ts");
    const navigation = read("src/app/app/(protected)/layout.tsx");
    for (const entity of ["enquiries", "bookings", "invoices"]) {
      expect(page).toContain(`entity: "${entity}"`);
    }
    // The Cal.com-era service catalogue left with P2.4; services are managed in Setup.
    for (const removed of ["inventory", "news", "media", "reviews", "offers", "catalogue_systems", "catalogue_services"]) {
      expect(page).not.toContain(`entity: "${removed}"`);
      expect(actions).not.toContain(`"${removed}"`);
    }
    expect(navigation).toContain('href: "/app/trash"');
    expect(page).toContain('mode="trash"');
  });

  it("adds bulk selection and move-to-trash controls to every active list", () => {
    const files = [
      "src/app/app/(protected)/enquiries/page.tsx",
      "src/app/app/(protected)/bookings/page.tsx",
      "src/app/app/(protected)/invoices/page.tsx",
    ];
    for (const file of files) expect(read(file)).toContain("<AdminBulkActions");
    const control = read("src/components/admin/admin-bulk-actions.tsx");
    expect(control).toContain("Select all visible");
    expect(control).toContain("Move to trash");
    expect(control).toContain("Restore");
    expect(control).toContain("Delete permanently");
  });
});
