import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serviceCatalogue } from "@/config/service-catalogue";
import { listGarageServices, listServiceCatalogue } from "@/lib/service-catalogue/repository";
import { createFakeSupabase, hasFilter } from "./support/fake-supabase";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const GARAGE = "11111111-1111-4111-8111-111111111111";

describe("garage services", () => {
  it("reads the garage's own services from the native services table", async () => {
    const fake = createFakeSupabase({
      from: () => ({ data: [{ id: "s1", name: "Full service", description: null, duration_min: 90, price_pence: 14900, price_mode: "fixed", location_mode: "workshop", online_enabled: true, is_mot: false, sort: 1 }] }),
    });
    const services = await listGarageServices(fake.client, GARAGE);
    expect(services).toEqual([{ id: "s1", name: "Full service", description: "", durationMin: 90, pricePence: 14900, priceMode: "fixed", locationMode: "workshop", onlineEnabled: true, isMot: false, sort: 1 }]);
    const [query] = fake.queries;
    expect(query?.table).toBe("services");
    expect(hasFilter(query!, "eq", "garage_id", GARAGE)).toBe(true);
    expect(hasFilter(query!, "is", "deleted_at", null)).toBe(true);
    expect(await listServiceCatalogue(fake.client, GARAGE)).toEqual([expect.objectContaining({ key: "services", services })]);
  });

  it("returns nothing without a client, a garage or on error", async () => {
    expect(await listGarageServices(null, GARAGE)).toEqual([]);
    expect(await listGarageServices(createFakeSupabase().client, "")).toEqual([]);
    const failing = createFakeSupabase({ from: () => ({ error: { code: "42P01", message: "missing" } }) });
    expect(await listServiceCatalogue(failing.client, GARAGE)).toEqual([]);
  });

  it("feeds invoice line items and keeps the static fallback catalogue", () => {
    expect(serviceCatalogue.length).toBeGreaterThan(0);
    expect(source("src/components/admin/invoice-form.tsx")).toContain("serviceCategories={serviceCategories}");
    expect(source("src/app/app/(protected)/invoices/new/page.tsx")).toContain("listServiceCatalogue(client");
  });

  it("no longer reads the Cal.com-era catalogue tables", () => {
    for (const path of [
      "src/lib/service-catalogue/repository.ts",
      "src/app/app/(protected)/service-catalogue/page.tsx",
      "src/app/app/(protected)/trash/page.tsx",
      "src/app/app/(protected)/trash/actions.ts",
      "src/app/app/(protected)/page.tsx",
    ]) {
      const text = source(path);
      expect(text, path).not.toContain('from("booking_service_types")');
      expect(text, path).not.toContain('from("service_catalogue_systems")');
      expect(text, path).not.toContain("catalogue_services");
    }
  });
});
