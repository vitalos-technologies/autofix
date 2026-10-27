import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingStatus } from "@/lib/booking-engine/types";
import { normalizeRegistration } from "@/lib/vehicle/registration-format";

// Customers & cars reads for the garage admin. Every function takes the
// caller's RLS client (getAdminContext().client), so rows are the selected
// garage's only. Search terms arrive in a POST body, never a URL.

export const CUSTOMER_PAGE_SIZE = 25;

type Related<T> = T | T[] | null;

function many<T>(value: Related<T>): T[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function one<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export type CustomerVehicle = {
  id: string;
  registration: string | null;
  make: string | null;
  model: string | null;
  motExpiry: string | null;
  motCheckedAt: string | null;
  enrichmentStatus: "pending" | "done" | "not_found" | "failed" | null;
};

export type CustomerListItem = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  reminderConsent: boolean;
  consentSource: string | null;
  optedOutAt: string | null;
  vehicles: CustomerVehicle[];
  /** Earliest MOT expiry among the customer's cars. */
  motDue: string | null;
};

export type CustomerListResult = {
  items: CustomerListItem[];
  total: number;
  page: number;
  pageCount: number;
  query: string;
  error: boolean;
};

type VehicleRow = {
  id: string;
  registration: string | null;
  make: string | null;
  model: string | null;
  mot_expiry: string | null;
  mot_checked_at: string | null;
  enrichment_status: CustomerVehicle["enrichmentStatus"];
};

type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  reminder_consent: boolean;
  consent_source: string | null;
  opted_out_at: string | null;
  vehicles: Related<VehicleRow>;
};

const VEHICLE_COLUMNS = "id,registration,make,model,mot_expiry,mot_checked_at,enrichment_status";

function toVehicle(row: VehicleRow): CustomerVehicle {
  return {
    id: row.id,
    registration: row.registration,
    make: row.make,
    model: row.model,
    motExpiry: row.mot_expiry,
    motCheckedAt: row.mot_checked_at,
    enrichmentStatus: row.enrichment_status,
  };
}

function toListItem(row: CustomerRow): CustomerListItem {
  const vehicles = many(row.vehicles).map(toVehicle).sort((a, b) => (a.registration ?? "").localeCompare(b.registration ?? ""));
  const motDates = vehicles.map((vehicle) => vehicle.motExpiry).filter((value): value is string => Boolean(value)).sort();
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    reminderConsent: row.reminder_consent,
    consentSource: row.consent_source,
    optedOutAt: row.opted_out_at,
    vehicles,
    motDue: motDates[0] ?? null,
  };
}

/** Search text as typed, without characters PostgREST filters treat specially. */
export function cleanSearch(value: unknown) {
  return typeof value === "string" ? value.replace(/[^\p{L}\p{N}\s@.'+-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

/** The digits of a phone search without the trunk 0 or the 44 country code, so `07700 900` finds `+447700900…`. */
export function phoneSearchDigits(query: string) {
  const digits = query.replace(/\D/g, "");
  if (!digits || digits.length !== query.replace(/[\s+()-]/g, "").length) return "";
  return digits.replace(/^(?:0044|44|0)/, "");
}

export async function listCustomers(
  client: SupabaseClient,
  options: { query?: string; page?: number; pageSize?: number } = {},
): Promise<CustomerListResult> {
  const query = cleanSearch(options.query);
  const pageSize = options.pageSize ?? CUSTOMER_PAGE_SIZE;
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const empty = { items: [], total: 0, page: 1, pageCount: 1, query };

  const filters: string[] = [];
  if (query) {
    filters.push(`name.ilike."*${query}*"`, `email.ilike."*${query}*"`);
    const digits = phoneSearchDigits(query);
    if (digits.length >= 4) filters.push(`phone.like.*${digits}*`);
    const registration = normalizeRegistration(query);
    if (registration.length >= 2) {
      const vehicles = await client.from("vehicles").select("customer_id").ilike("registration", `%${registration}%`).not("customer_id", "is", null).limit(200);
      if (vehicles.error) return { ...empty, error: true };
      const ids = [...new Set((vehicles.data ?? []).map((row) => String(row.customer_id)))];
      if (ids.length) filters.push(`id.in.(${ids.join(",")})`);
    }
  }

  const select = () => {
    let builder = client
      .from("customers")
      .select(`id,name,phone,email,reminder_consent,consent_source,opted_out_at,vehicles(${VEHICLE_COLUMNS})`, { count: "exact" })
      .is("anonymised_at", null);
    if (filters.length) builder = builder.or(filters.join(","));
    return builder;
  };

  const run = (page: number) => select()
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);

  let page = requestedPage;
  let result = await run(page);
  if (result.error && result.error.code !== "PGRST103") return { ...empty, error: true };
  let total = result.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (page > pageCount) {
    page = pageCount;
    result = await run(page);
    if (result.error) return { ...empty, error: true };
    total = result.count ?? total;
  }
  return {
    items: ((result.data ?? []) as unknown as CustomerRow[]).map(toListItem),
    total,
    page,
    pageCount,
    query,
    error: false,
  };
}

export type CustomerBooking = {
  id: string;
  reference: string;
  status: BookingStatus;
  startsAt: string;
  serviceName: string | null;
  registration: string | null;
};

export type ConsentEvent = {
  at: string;
  kind: "consent" | "opt_out" | "import" | "audit";
  label: string;
  detail?: string;
};

export type CustomerDetail = CustomerListItem & {
  preferredContact: string;
  channel: string;
  consentAt: string | null;
  consentText: string | null;
  createdAt: string;
  importFile: { fileName: string; createdAt: string; declared: boolean } | null;
  bookings: CustomerBooking[];
  history: ConsentEvent[];
};

const CONSENT_SOURCE_LABELS: Record<string, string> = {
  booking: "Ticked the reminder box when booking",
  import: "Imported with the garage's consent declaration",
  soft_opt_in: "Existing customer (soft opt-in)",
  staff: "Recorded by staff",
};

export function consentSourceLabel(source: string | null) {
  return source ? CONSENT_SOURCE_LABELS[source] ?? "Consent recorded" : "No consent recorded";
}

type DetailRow = CustomerRow & {
  preferred_contact: string;
  channel: string;
  consent_at: string | null;
  consent_text: string | null;
  created_at: string;
  anonymised_at: string | null;
  customer_imports: Related<{ file_name: string; created_at: string; declaration_accepted_at: string | null }>;
};

type BookingRow = {
  id: string;
  reference: string;
  status: BookingStatus;
  starts_at: string;
  services: Related<{ name: string }>;
  vehicles: Related<{ registration: string | null }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One customer of the selected garage, or null (unknown id, another garage's id, anonymised). */
export async function getCustomerDetail(client: SupabaseClient, customerId: string): Promise<CustomerDetail | null> {
  if (!UUID.test(customerId)) return null;
  const { data, error } = await client
    .from("customers")
    .select(`id,name,phone,email,reminder_consent,consent_source,consent_at,consent_text,opted_out_at,preferred_contact,channel,created_at,anonymised_at,vehicles(${VEHICLE_COLUMNS}),customer_imports(file_name,created_at,declaration_accepted_at)`)
    .eq("id", customerId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as DetailRow;
  if (row.anonymised_at) return null;

  const [bookings, audit] = await Promise.all([
    client
      .from("bookings")
      .select("id,reference,status,starts_at,services(name),vehicles(registration)")
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .order("starts_at", { ascending: false })
      .limit(50),
    client
      .from("admin_audit_log")
      .select("action,created_at")
      .eq("entity_type", "customer")
      .eq("entity_id", customerId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const importRow = one(row.customer_imports);
  const history: ConsentEvent[] = [];
  if (row.consent_at) {
    history.push({ at: row.consent_at, kind: "consent", label: consentSourceLabel(row.consent_source), detail: row.consent_text ?? undefined });
  }
  if (row.opted_out_at) history.push({ at: row.opted_out_at, kind: "opt_out", label: "Opted out of reminders" });
  if (importRow) {
    history.push({
      at: importRow.created_at,
      kind: "import",
      label: `Imported from ${importRow.file_name}`,
      detail: importRow.declaration_accepted_at ? "Consent declaration ticked" : "Consent declaration not ticked",
    });
  }
  for (const entry of (audit.data ?? []) as Array<{ action: string; created_at: string }>) {
    if (entry.action === "customer.opted_out") continue; // shown by opted_out_at
    history.push({ at: entry.created_at, kind: "audit", label: entry.action.replace(/^customer\./, "").replace(/_/g, " ") });
  }
  history.sort((a, b) => b.at.localeCompare(a.at));

  return {
    ...toListItem(row),
    preferredContact: row.preferred_contact,
    channel: row.channel,
    consentAt: row.consent_at,
    consentText: row.consent_text,
    createdAt: row.created_at,
    importFile: importRow
      ? { fileName: importRow.file_name, createdAt: importRow.created_at, declared: Boolean(importRow.declaration_accepted_at) }
      : null,
    bookings: ((bookings.data ?? []) as unknown as BookingRow[]).map((booking) => ({
      id: booking.id,
      reference: booking.reference,
      status: booking.status,
      startsAt: booking.starts_at,
      serviceName: one(booking.services)?.name ?? null,
      registration: one(booking.vehicles)?.registration ?? null,
    })),
    history,
  };
}

export type CustomerImportSummary = {
  id: string;
  fileName: string;
  status: "importing" | "completed" | "failed";
  createdAt: string;
  totalRows: number;
  importedRows: number;
  customersCreated: number;
  consentRecorded: number;
};

/** The garage's latest imports, newest first. */
export async function listRecentImports(client: SupabaseClient, limit = 5): Promise<CustomerImportSummary[]> {
  const { data } = await client
    .from("customer_imports")
    .select("id,file_name,status,created_at,total_rows,imported_rows,customers_created,consent_recorded")
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    fileName: String(row.file_name),
    status: row.status as CustomerImportSummary["status"],
    createdAt: String(row.created_at),
    totalRows: Number(row.total_rows),
    importedRows: Number(row.imported_rows),
    customersCreated: Number(row.customers_created),
    consentRecorded: Number(row.consent_recorded),
  }));
}
