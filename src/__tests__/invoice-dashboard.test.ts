import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { functionDefinition } from "./support/migrations";
import {
  invoiceDashboardPageSize,
  loadInvoiceDashboard,
  normalizeInvoiceDashboardFilters,
} from "@/lib/invoices/dashboard";

describe("invoice dashboard query", () => {
  it("normalizes untrusted URL filters before they reach PostgreSQL", () => {
    expect(normalizeInvoiceDashboardFilters({
      q: `  ${"x".repeat(250)}  `,
      status: "administrator",
      date: "2026-02-31",
      page: "1e3",
    })).toEqual({ query: "x".repeat(200), status: "", date: "", requestedPage: 1 });

    expect(normalizeInvoiceDashboardFilters({
      q: " AB12 CDE ",
      status: "issued",
      date: "2026-08-11",
      page: "42",
    })).toEqual({ query: "AB12 CDE", status: "issued", date: "2026-08-11", requestedPage: 42 });
  });

  it("uses the guarded database RPC and preserves integer totals as strings", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        invoices: [{ id: "invoice-1", total_pence: 9007199254740991 }],
        matching_count: "1005",
        page: 41,
        pages: 41,
        draft_count: "1005",
        outstanding_count: "2",
        paid_count: "7",
        outstanding_total_pence: "9007199254740992",
        current_week_paid_total_pence: "123456",
      },
      error: null,
    });
    const filters = normalizeInvoiceDashboardFilters({ q: "smith", status: "issued", page: "999" });
    const result = await loadInvoiceDashboard({ rpc } as unknown as SupabaseClient, filters);

    expect(rpc).toHaveBeenCalledWith("get_invoice_dashboard", {
      p_query: "smith",
      p_status: "issued",
      p_date: null,
      p_page: 999,
      p_page_size: invoiceDashboardPageSize,
    });
    expect(result).toMatchObject({
      matchingCount: "1005",
      page: 41,
      pages: 41,
      draftCount: "1005",
      outstandingTotalPence: "9007199254740992",
      currentWeekPaidTotalPence: "123456",
      error: null,
    });
  });

  it("defines a staff-only, garage-scoped, uncapped server-side query", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20261026000100_tenancy.sql"),
      "utf8",
    );
    const query = functionDefinition(migration, "get_invoice_dashboard_without_payments");
    expect(query).toContain("perform public.require_invoice_actor()");
    expect(query).toContain("where invoice.garage_id = garage_scope");
    expect(query).toContain("matching_count::text");
    expect(query).toContain("outstanding_total::text");
    expect(query).toContain("offset (effective_page - 1) * p_page_size");
    expect(query).not.toMatch(/limit\s+500/i);
    expect(migration).toContain("revoke all on all functions in schema public from public, anon, authenticated, service_role;");
    expect(migration).toContain("grant execute on function public.get_invoice_dashboard(text, text, date, integer, integer) to authenticated;");
  });

  it("totals payments from the current week in the garage's time zone", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20261026000100_tenancy.sql"),
      "utf8",
    );
    const dashboard = functionDefinition(migration, "get_invoice_dashboard");
    expect(dashboard).toContain("current_week_paid_total_pence");
    expect(dashboard).toContain("timezone(garage_timezone, statement_timestamp())");
    expect(dashboard).toContain("invoice.paid_at >= week_start");
    expect(dashboard).toContain("invoice.paid_at < week_end");
  });

  it("uses the shared admin pagination and preserves invoice filters", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/admin/(protected)/invoices/page.tsx"),
      "utf8",
    );
    expect(source).toContain('<AdminPagination path="/admin/invoices"');
    expect(source).toContain("totalItems={matchingCount}");
    expect(source).toContain("totalPages={pages}");
    expect(source).toContain("additionalParams={{ date }}");
  });

  it("matches the appointment table's customer and vehicle column spacing", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/admin/(protected)/invoices/page.tsx"),
      "utf8",
    );
    expect(source).toContain('min-w-[1100px] table-fixed');
    expect(source).toContain('<col className="w-[4%]" /><col className="w-[9%]" /><col className="w-[16%]" /><col className="w-[17%]" />');
  });
});
