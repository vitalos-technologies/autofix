/**
 * Customer import (P3.11) against local Supabase: a 1,000-row CSV goes
 * through the same parser and RPC runner the import action uses, on a garage
 * owner's RLS client (AAL2), and must finish in under 60 seconds with the
 * right customers, cars and consent. Then the first enrichment batch runs
 * against the real vehicles table with the mock provider.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parseCustomerCsv } from "@/lib/customers/csv";
import { importDeclaration } from "@/lib/customers/declaration";
import { enrichImportedVehicles } from "@/lib/customers/enrichment";
import { runCustomerImport } from "@/lib/customers/import";
import { getConfiguredEnrichmentLookup } from "@/lib/vehicle/configured-provider";
import {
  createLocalClient,
  createLocalGarage,
  createLocalIdentity,
  createLocalMfaIdentity,
  getLocalSupabaseConfig,
  localRunId,
  type LocalTestGarage,
} from "../helpers/local-supabase";

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);
const ROWS = 1000;
const LIMIT_MS = 60_000;

// Drama-range mobiles 07700 900000..900999 are exactly 1,000 numbers.
function mobile(index: number) {
  return `07700 9${String(index).padStart(5, "0")}`;
}

/** Two letters + two digits + three letters from the index, always a valid current-style plate. */
function plate(index: number) {
  const letters = "ABCDEFGHJKLMNOPRSTUVWXYZ";
  const pick = (value: number) => letters[value % letters.length];
  return `${pick(index)}${pick(Math.floor(index / 24))}${String(index % 100).padStart(2, "0")} ${pick(index + 3)}${pick(index + 7)}${pick(Math.floor(index / 24) + 11)}`;
}

function generatedCsv() {
  const lines = ["Customer Name,Mobile Number,Email,Reg No,Consent"];
  for (let index = 0; index < ROWS; index += 1) {
    // Every third row says no to reminders; every tenth has no car; some lost their leading zero in Excel.
    const phone = index % 50 === 0 ? mobile(index).replace(/^0/, "").replace(" ", "") : mobile(index);
    lines.push([`Customer ${index}`, phone, index % 4 === 0 ? `customer${index}@example.test` : "", index % 10 === 9 ? "" : plate(index), index % 3 === 0 ? "no" : "yes"].join(","));
  }
  return lines.join("\r\n");
}

let garage: LocalTestGarage;
let otherGarage: LocalTestGarage;
let owner: ReturnType<typeof createLocalClient>;
let otherManager: ReturnType<typeof createLocalClient>;

beforeAll(async () => {
  garage = await createLocalGarage(service, "ci");
  otherGarage = await createLocalGarage(service, "cj");
  const ownerIdentity = await createLocalMfaIdentity(service, config.publishableKey, `import-owner-${localRunId}@example.test`);
  const managerIdentity = await createLocalIdentity(service, config.publishableKey, `import-manager-b-${localRunId}@example.test`);
  const members = await service.from("garage_members").insert([
    { garage_id: garage.id, user_id: ownerIdentity.id, role: "owner" },
    { garage_id: otherGarage.id, user_id: managerIdentity.id, role: "manager" },
  ]);
  if (members.error) throw new Error(members.error.message);
  owner = createLocalClient(config.publishableKey, ownerIdentity.accessToken, garage.id);
  otherManager = createLocalClient(config.publishableKey, managerIdentity.accessToken, otherGarage.id);
  // Garage B already knows one of the numbers; it must stay untouched.
  const existing = await service.from("customers").insert({ garage_id: otherGarage.id, name: "Garage B customer", phone: "+447700900001", preferred_contact: "phone" });
  if (existing.error) throw new Error(existing.error.message);
}, 60_000);

describe("customer import of 1,000 rows", () => {
  let importId: string;

  it("imports in under 60 seconds with the right counts", async () => {
    const started = performance.now();
    const parsed = parseCustomerCsv(generatedCsv());
    expect(parsed.fatal).toBeNull();
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(ROWS);

    const result = await runCustomerImport(owner, { fileName: "big-import.csv", parsed, declarationText: importDeclaration(garage.name) });
    const elapsed = performance.now() - started;
    console.info(`[customer-import] ${ROWS} rows imported in ${Math.round(elapsed)} ms`);

    expect(elapsed).toBeLessThan(LIMIT_MS);
    expect(result).toMatchObject({
      ok: true,
      importedRows: ROWS,
      counts: { customersCreated: ROWS, customersUpdated: 0, vehiclesCreated: 900, vehiclesUpdated: 0, consentRecorded: 666 },
    });
    if (!result.ok) throw new Error("import failed");
    importId = result.importId;
  }, LIMIT_MS + 10_000);

  it("stores customers, cars and consent in the garage", async () => {
    const customers = await service.from("customers").select("id", { count: "exact", head: true }).eq("garage_id", garage.id).eq("import_id", importId);
    expect(customers.count).toBe(ROWS);
    const consented = await service
      .from("customers")
      .select("consent_source,consent_text,consent_at")
      .eq("garage_id", garage.id)
      .eq("reminder_consent", true);
    expect(consented.data).toHaveLength(666);
    expect(new Set(consented.data?.map((row) => `${row.consent_source}|${row.consent_text}`))).toEqual(new Set([`import|${importDeclaration(garage.name)}`]));
    const vehicles = await service.from("vehicles").select("id", { count: "exact", head: true }).eq("garage_id", garage.id).eq("enrichment_status", "pending");
    expect(vehicles.count).toBe(900);
    const mangled = await service.from("customers").select("name").eq("garage_id", garage.id).eq("phone", "+447700900050").single();
    expect(mangled.data?.name).toBe("Customer 50");

    const record = await owner.from("customer_imports").select("status,total_rows,imported_rows,consent_recorded,declaration_text,declaration_accepted_at").eq("id", importId).single();
    expect(record.data).toMatchObject({ status: "completed", total_rows: ROWS, imported_rows: ROWS, consent_recorded: 666, declaration_text: importDeclaration(garage.name) });
    expect(record.data?.declaration_accepted_at).toBeTruthy();
  });

  it("leaves the other garage alone", async () => {
    const other = await service.from("customers").select("name,reminder_consent").eq("garage_id", otherGarage.id);
    expect(other.data).toEqual([{ name: "Garage B customer", reminder_consent: false }]);
    const imports = await otherManager.from("customer_imports").select("id").eq("id", importId);
    expect(imports.data).toEqual([]);
    const planted = await otherManager.rpc("import_customer_rows", { p_import_id: importId, p_rows: [{ name: "Planted", phone: "+447700900999", registration: null }] });
    expect(planted.error?.message).toBe("IMPORT_NOT_FOUND");
  });

  it("is idempotent: importing the same file again creates nothing", async () => {
    const parsed = parseCustomerCsv(generatedCsv());
    const again = await runCustomerImport(owner, { fileName: "big-import.csv", parsed, declarationText: importDeclaration(garage.name) });
    expect(again).toMatchObject({ ok: true, counts: { customersCreated: 0, customersUpdated: ROWS, vehiclesCreated: 0, vehiclesUpdated: 900, consentRecorded: 0 } });
    const customers = await service.from("customers").select("id", { count: "exact", head: true }).eq("garage_id", garage.id);
    expect(customers.count).toBe(ROWS);
  }, LIMIT_MS);

  it("enriches the first batch of cars from the mock provider", async () => {
    const result = await enrichImportedVehicles({
      garageId: garage.id,
      limit: 25,
      client: service,
      lookup: getConfiguredEnrichmentLookup({ VEHICLE_LOOKUP_PROVIDER: "mock" }),
      pauseMs: 0,
    });
    expect(result).toMatchObject({ checked: 25, enriched: 25, remaining: true, stoppedReason: "limit" });
    const done = await service.from("vehicles").select("mot_expiry,mot_checked_at,make").eq("garage_id", garage.id).eq("enrichment_status", "done");
    expect(done.data).toHaveLength(25);
    expect(done.data?.every((row) => row.mot_expiry === "2027-03-31" && row.mot_checked_at && row.make === "Vauxhall")).toBe(true);
    const otherVehicles = await service.from("vehicles").select("id", { count: "exact", head: true }).eq("garage_id", otherGarage.id).eq("enrichment_status", "done");
    expect(otherVehicles.count).toBe(0);
  });
});
