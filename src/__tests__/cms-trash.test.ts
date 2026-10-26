import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("CMS trash", () => {
  it("adds recoverable deletion metadata and a restricted bulk management function", () => {
    const migration = read("supabase/migrations/20260928124203_add_cms_trash.sql");
    for (const table of ["enquiries", "bookings", "invoices", "sale_vehicles", "content_entries", "media_assets", "reviews", "offers"]) {
      expect(migration).toContain(`alter table public.${table} add column if not exists deleted_at`);
    }
    expect(migration).toContain("create or replace function public.manage_admin_trash");
    expect(migration).toContain("auth.uid() is null or not public.is_admin()");
    expect(migration).toContain("status = 'draft'");
    expect(migration).toContain("grant execute on function public.manage_admin_trash(text,uuid[],text) to authenticated");
  });

  it("shows a separated trash section for every record-based admin module", () => {
    const page = read("src/app/app/(protected)/trash/page.tsx");
    const actions = read("src/app/app/(protected)/trash/actions.ts");
    const navigation = read("src/components/admin/admin-navigation.tsx");
    for (const entity of ["enquiries", "bookings", "invoices", "catalogue_systems", "catalogue_services"]) {
      expect(page).toContain(`entity: "${entity}"`);
    }
    for (const removed of ["inventory", "news", "media", "reviews", "offers"]) {
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
