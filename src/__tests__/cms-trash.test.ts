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

  it("shows a separated trash section for every record-based CMS module", () => {
    const page = read("src/app/admin/(protected)/trash/page.tsx");
    const navigation = read("src/components/admin/admin-navigation.tsx");
    for (const entity of ["enquiries", "bookings", "invoices", "inventory", "news", "media", "reviews", "offers"]) {
      expect(page).toContain(`entity: "${entity}"`);
    }
    expect(navigation).toContain('href: "/admin/trash"');
    expect(page).toContain('mode="trash"');
  });

  it("adds bulk selection and move-to-trash controls to every active list", () => {
    const files = [
      "src/app/admin/(protected)/enquiries/page.tsx",
      "src/app/admin/(protected)/bookings/page.tsx",
      "src/app/admin/(protected)/invoices/page.tsx",
      "src/app/admin/(protected)/inventory/page.tsx",
      "src/app/admin/(protected)/news/page.tsx",
      "src/app/admin/(protected)/media/page.tsx",
      "src/app/admin/(protected)/reviews/page.tsx",
      "src/app/admin/(protected)/offers/page.tsx",
    ];
    for (const file of files) expect(read(file)).toContain("<AdminBulkActions");
    const control = read("src/components/admin/admin-bulk-actions.tsx");
    expect(control).toContain("Select all visible");
    expect(control).toContain("Move to trash");
    expect(control).toContain("Restore");
    expect(control).toContain("Delete permanently");
  });

  it("keeps trashed records out of public repositories", () => {
    for (const file of [
      "src/lib/content/repository.ts",
      "src/lib/news/repository.ts",
      "src/lib/media/repository.ts",
      "src/lib/reviews/repository.ts",
      "src/lib/offers/repository.ts",
      "src/lib/sales/repository.ts",
    ]) expect(read(file)).toContain('is("deleted_at", null)');
  });
});

describe("steered UI changes", () => {
  it("uses sales-specific enquiry wording", () => {
    const source = read("src/components/forms/enquiry-form.tsx");
    expect(source).toContain('type === "vehicle_sales" ? "What would you like to know?"');
    expect(source).toContain("Ask about availability, condition, part exchange or arranging a viewing.");
  });
});
