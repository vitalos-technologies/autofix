import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serviceCatalogue } from "@/config/service-catalogue";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("shared service catalogue", () => {
  it("keeps a per-garage database catalogue of vehicle systems and services", () => {
    // SOB's seeded catalogue rows are not carried into the multi-tenant
    // baseline; each garage's catalogue is created with the garage.
    expect(serviceCatalogue.length).toBeGreaterThan(0);
    const baseline = source("supabase/migrations/20261026000000_baseline.sql");
    const tenancy = source("supabase/migrations/20261026000100_tenancy.sql");
    expect(baseline).toContain("create table public.service_catalogue_systems");
    expect(baseline).toContain("system_id uuid references public.service_catalogue_systems(id)");
    expect(tenancy).toContain("unique (garage_id, system_key)");
    expect(tenancy).toContain("unique (garage_id, service_key)");
    expect(tenancy).toContain("foreign key (garage_id, system_id)\n    references public.service_catalogue_systems (garage_id, id)");
  });

  it("uses the database catalogue for booking and invoices", () => {
    const booking = source("src/lib/bookings/services.ts");
    const invoice = source("src/components/admin/invoice-form.tsx");
    expect(booking).toContain("listServiceCatalogue(createAdminClient(), garageId, { bookableOnly: true })");
    // Every catalogue query is scoped to one garage.
    expect(source("src/lib/service-catalogue/repository.ts").match(/\.eq\("garage_id", garageId\)/g)).toHaveLength(3);
    expect(invoice).toContain("serviceCategories={serviceCategories}");
  });

  it("presents vehicle systems before their services in the customer booking flow", () => {
    const wizard = source("src/components/booking/booking-wizard.tsx");
    expect(wizard).toContain("1. Choose the vehicle system");
    expect(wizard).toContain("2. Choose a service under");
    expect(wizard).toContain("systemKey");
    expect(wizard).toContain('view === "systems"');
    expect(wizard).toContain("Other / Fault not listed");
    expect(wizard).toContain("Add another vehicle system repair");
    expect(wizard).toContain("Clear selection");
    expect(wizard).toContain('services: [...system.services].sort((left, right) => left.name.localeCompare(right.name, "en-GB"))');
    expect(wizard).toContain('.sort((left, right) => left.name.localeCompare(right.name, "en-GB"));');
    expect(wizard).toContain('const allSystems = [...systems, { key: "other", name: "Other / Fault not listed", services: [] as BookingService[] }];');
    expect(wizard).not.toContain("{system.description}");
    expect(wizard).not.toContain("{system.services.length} services");
    expect(wizard).not.toContain("{service.description}");
    expect(wizard).not.toContain("locationModeLabel(service.locationMode)");
  });

  it("provides an editable CMS portfolio and recoverable deletion", () => {
    const page = source("src/app/app/(protected)/service-catalogue/page.tsx");
    const editor = source("src/app/app/(protected)/service-catalogue/catalogue-editor.tsx");
    const trash = source("src/app/app/(protected)/trash/actions.ts");
    expect(page).toContain("Service catalogue");
    expect(editor).toContain("createCatalogueSystemAction");
    expect(editor).toContain("updateCatalogueServiceAction");
    expect(editor).not.toContain('title="Calendar event ID"');
    expect(editor).not.toContain('title="Order"');
    expect(editor).toContain('type="hidden" name="providerEventTypeId"');
    expect(editor).toContain('type="hidden" name="sortOrder"');
    expect(editor).toContain("group-open:bg-[#071127]");
    expect(trash).toContain('"catalogue_systems"');
    expect(trash).toContain('"catalogue_services"');
  });
});
