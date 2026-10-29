/**
 * Gate 1 (P1.10): no garage can read or write another garage's rows.
 *
 * The suite discovers every base table in `public` that has a `garage_id`
 * column (information_schema, through the service-role helpers in
 * supabase/migrations/20261026000200_tenancy_test_support.sql) and, for each
 * one:
 *
 *   structure   RLS is on, every policy is scoped by current_garage_id(),
 *               anon holds no privilege, no policy applies to anon/public.
 *   behaviour   with real rows in two fresh garages, as anon, as garage A's
 *               owner/manager/technician, as garage B's owner, as B's owner
 *               forging `x-garage-id: A`, as B's owner with no header, and as a
 *               manager of both garages with A selected: select, insert,
 *               update and delete against the other garage return zero rows or
 *               fail with 42501, and rows cannot be moved into the other
 *               garage. Positive controls prove staff still see their own rows.
 *   integrity   afterwards the service role sees both garages' rows unchanged
 *               (row counts and checksums).
 *
 * It also covers `garages`, the platform tables without `garage_id`
 * (DECISIONS.md A10) and `storage.objects` (paths under `<garage_id>/`).
 *
 * A new garage table needs an entry in FIXTURES: how to create a row in a
 * garage (service role or the proper RPC) and a harmless update probe. Until
 * it has one, this suite fails with "no fixture for table <name>".
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalClient,
  createLocalGarage,
  createLocalIdentity,
  createLocalMfaIdentity,
  getLocalSupabaseConfig,
  invoiceDraftPayload,
  localRunId,
  type LocalTestGarage,
  type LocalTestIdentity,
} from "../helpers/local-supabase";

// ---------------------------------------------------------------------------
// Catalogue (discovered at collection time so every table gets named tests)
// ---------------------------------------------------------------------------

type CatalogColumn = {
  name: string;
  type: string;
  not_null: boolean;
  has_default: boolean;
  identity: boolean;
  generated: boolean;
  authenticated_select: boolean;
  authenticated_insert: boolean;
  authenticated_update: boolean;
};

type CatalogTable = {
  table_name: string;
  table_kind: "table" | "partitioned_table" | "view" | "materialized_view" | "foreign_table";
  has_garage_id: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  security_invoker: boolean;
  primary_key: string[];
  anon_privileges: string[];
  authenticated_privileges: string[];
  columns: CatalogColumn[];
};

type CatalogPolicy = {
  schema_name: string;
  table_name: string;
  policy_name: string;
  command: string;
  permissive: string;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
};

type FunctionGrant = {
  signature: string;
  security_definer: boolean;
  anon_execute: boolean;
  authenticated_execute: boolean;
};

type Fingerprint = { row_count: number; checksum: string };

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);

async function rpcRows<T>(name: string, args?: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await service.rpc(name, args);
  if (error) throw new Error(`${name}() failed: ${error.message} (${error.code}). Is 20261026000200_tenancy_test_support.sql applied?`);
  return (data ?? []) as T[];
}

const catalog = await rpcRows<CatalogTable>("tenancy_tables");
const policies = await rpcRows<CatalogPolicy>("tenancy_policies");
const functionGrants = await rpcRows<FunctionGrant>("tenancy_function_grants");

const BASE_TABLE_KINDS = new Set(["table", "partitioned_table"]);
const tableByName = new Map(catalog.map((table) => [table.table_name, table]));
const garageTables = catalog.filter((table) => table.has_garage_id && BASE_TABLE_KINDS.has(table.table_kind)).map((table) => table.table_name);
const platformTables = catalog
  .filter((table) => !table.has_garage_id && BASE_TABLE_KINDS.has(table.table_kind) && table.table_name !== "garages")
  .map((table) => table.table_name);

function tableMeta(name: string): CatalogTable {
  const table = tableByName.get(name);
  if (!table) throw new Error(`Table ${name} is not in the catalogue`);
  return table;
}

function policiesOn(schema: string, table: string) {
  return policies.filter((policy) => policy.schema_name === schema && policy.table_name === table);
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

type GarageKey = "A" | "B";
const other = (key: GarageKey): GarageKey => (key === "A" ? "B" : "A");

type ActorKey =
  | "anon"
  | "anonForgingA"
  | "ownerA"
  | "managerA"
  | "technicianA"
  | "ownerB"
  | "ownerBForgingA"
  | "ownerBNoHeader"
  | "sharedWithA";

type ActorSpec = {
  key: ActorKey;
  label: string;
  /** The garage whose rows this actor must never reach. */
  victim: GarageKey;
  /** The garage the actor has selected as a member, if any (positive controls). */
  selected?: GarageKey;
};

const ACTORS: ActorSpec[] = [
  { key: "anon", label: "anon", victim: "A" },
  { key: "anonForgingA", label: "anon sending x-garage-id A", victim: "A" },
  { key: "ownerA", label: "A owner", victim: "B", selected: "A" },
  { key: "managerA", label: "A manager", victim: "B", selected: "A" },
  { key: "technicianA", label: "A technician", victim: "B", selected: "A" },
  { key: "ownerB", label: "B owner", victim: "A", selected: "B" },
  { key: "ownerBForgingA", label: "B owner forging x-garage-id A", victim: "A" },
  { key: "ownerBNoHeader", label: "B owner without x-garage-id", victim: "A" },
  { key: "sharedWithA", label: "A+B manager with A selected", victim: "B", selected: "A" },
];

type Actor = ActorSpec & { client: SupabaseClient; userId: string | null };

/** Each member actor's role in its selected garage. */
const ACTOR_ROLES: Partial<Record<ActorKey, "owner" | "manager" | "technician">> = {
  ownerA: "owner",
  managerA: "manager",
  technicianA: "technician",
  ownerB: "owner",
  sharedWithA: "manager",
};

/**
 * Tables whose select policy also limits the role (P5.2 billing and usage). Members outside these
 * roles read zero rows of their own garage; everyone else's positive control reads them all.
 */
const ROLE_LIMITED_READS: Record<string, ReadonlyArray<"owner" | "manager" | "technician">> = {
  accounting_connections: ["owner", "manager"],
  accounting_sync_items: ["owner", "manager"],
  billing_usage_reports: ["owner"],
  garage_group_sites: ["owner", "manager"],
  garage_groups: ["owner", "manager"],
  garage_subscriptions: ["owner"],
  plan_requests: ["owner"],
  usage_events: ["owner", "manager"],
  payment_accounts: ["owner", "manager"],
};

// ---------------------------------------------------------------------------
// Fixtures: one or more rows per garage table, per garage
// ---------------------------------------------------------------------------

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

class GarageRows {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly garage: LocalTestGarage,
    /** The garage's owner (AAL2) with the garage selected, for staff RPCs. */
    readonly owner: SupabaseClient,
    readonly ownerId: string,
    readonly key: GarageKey,
  ) {}

  private once<T>(name: string, create: () => Promise<T>): Promise<T> {
    const existing = this.memo.get(name);
    if (existing) return existing as Promise<T>;
    const created = create();
    this.memo.set(name, created);
    return created;
  }

  /** Service-role insert with this garage's id; returns the requested columns. */
  async insert(table: string, values: Record<string, unknown>, returning = "garage_id") {
    const { data, error } = await service.from(table).insert({ garage_id: this.garage.id, ...values }).select(returning);
    if (error || !data?.length) throw new Error(`fixture ${table} (garage ${this.key}): ${error?.message ?? "no row returned"}`);
    return data[0] as unknown as Record<string, unknown>;
  }

  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.owner.rpc(name, args);
    if (error) throw new Error(`fixture rpc ${name} (garage ${this.key}): ${error.message}`);
    return data as T;
  }

  private tag(name: string) {
    return `${name}-${this.key.toLowerCase()}-${localRunId}`;
  }

  /** P5.9: the group this garage is the home of. */
  homeGroup = () => this.once("homeGroup", async () => String((await this.insert("garage_groups", { name: `Tenancy group ${this.key}` }, "id")).id));

  customer = () => this.once("customer", async () => String((await this.insert("customers", {
    name: `Tenancy Customer ${this.key}`,
    phone: this.key === "A" ? "+447700900901" : "+447700900902",
    email: `${this.tag("customer")}@example.test`,
    preferred_contact: "phone",
  }, "id")).id));

  vehicle = () => this.once("vehicle", async () => String((await this.insert("vehicles", {
    customer_id: await this.customer(),
    registration: `TN${this.key}${localRunId.slice(0, 4)}`.toUpperCase(),
    make: "Fixture",
    model: `Garage ${this.key}`,
  }, "id")).id));

  resource = () => this.once("resource", async () => String((await this.insert("resources", {
    name: `Tenancy bay ${this.key}`,
    kind: "bay",
    sort: 1,
  }, "id")).id));

  service = () => this.once("service", async () => String((await this.insert("services", {
    name: `Tenancy probe ${this.key}`,
    duration_min: 60,
    buffer_min: 15,
    price_pence: 4500,
    price_mode: "fixed",
  }, "id")).id));

  /** A booking written directly by the service role (create_booking() is covered by pgTAP 012). */
  booking = () => this.once("booking", async () => String((await this.insert("bookings", {
    customer_id: await this.customer(),
    vehicle_id: await this.vehicle(),
    service_id: await this.service(),
    resource_id: await this.resource(),
    starts_at: "2096-04-02T09:00:00.000Z",
    ends_at: "2096-04-02T10:00:00.000Z",
    during: "[2096-04-02T09:00:00.000Z,2096-04-02T10:15:00.000Z)",
    status: "confirmed",
    source: "phone",
  }, "id")).id));

  /** An E.164 number unique to this run and garage (tables with globally unique numbers). */
  runNumber(prefix: string) {
    const digits = (BigInt(`0x${localRunId}`) % 100_000_000n).toString().padStart(8, "0");
    return `+44${prefix}${this.key === "A" ? "1" : "2"}${digits}`;
  }

  /** P5.7: a business account (service role insert) and its monthly statement. */
  businessAccount = () => this.once("businessAccount", async () => String((await this.insert("business_accounts", {
    name: `Tenancy Fleet ${this.key}`,
    billing_email: `${this.tag("fleet")}@example.test`,
  }, "id")).id));

  accountStatement = () => this.once("accountStatement", async () => String((await this.insert("account_statements", {
    account_id: await this.businessAccount(),
    reference: `TN${this.key}-ST-209604-001`,
    period_start: "2096-04-01",
    period_end: "2096-04-30",
  }, "id")).id));

  reminderRule = () => this.once("reminderRule", async () => String((await this.insert("reminder_rules", {
    kind: "mot",
    enabled: true,
    offset_days: [28, 7],
    channel: "customer",
    template: `Tenancy probe ${this.key}: MOT due {due_date}. {link}`,
  }, "id")).id));

  call = () => this.once("call", async () => String((await this.insert("calls", {
    provider_call_sid: `CAtenancy${this.key}${localRunId}`,
    from_number: this.key === "A" ? "+447700900901" : "+447700900902",
    to_number: this.runNumber("79"),
    status: "no-answer",
    missed: true,
  }, "id")).id));

  /** An agent API token issued through the service-role function (only a hash is stored). */
  agentToken = () => this.once("agentToken", async () => {
    const { data, error } = await service.rpc("issue_agent_token", {
      p_garage_id: this.garage.id,
      p_name: `Tenancy agent ${this.key}`,
      p_scopes: null,
      p_token_hash: createHash("sha256").update(this.tag("agent-token")).digest("hex"),
    });
    if (error || !data) throw new Error(`fixture agent token (garage ${this.key}): ${error?.message ?? "no row returned"}`);
    return String((data as { id: string }).id);
  });

  enquiry = () => this.once("enquiry", async () => String((await this.insert("enquiries", {
    type: "general",
    customer_id: await this.customer(),
    vehicle_id: await this.vehicle(),
    booking_id: await this.booking(),
    description: `Tenancy probe enquiry ${this.key}`,
  }, "id")).id));

  enquiryMessage = () => this.once("enquiryMessage", async () => String((await this.insert("enquiry_messages", {
    enquiry_id: await this.enquiry(),
    direction: "internal",
    message_type: "internal_note",
    subject: `Tenancy probe ${this.key}`,
    text_body: `Internal note for garage ${this.key}`,
    delivery_status: "note",
  }, "id")).id));

  /** A customer import through the staff RPCs (P3.11), with one imported row. */
  customerImport = () => this.once("customerImport", async () => {
    const importId = String(await this.rpc("start_customer_import", {
      p_file_name: `${this.tag("import")}.csv`,
      p_summary: { total_rows: 1, valid_rows: 1 },
      p_declaration_text: `Tenancy probe declaration ${this.key}`,
    }));
    await this.rpc("import_customer_rows", {
      p_import_id: importId,
      p_rows: [{ name: `Imported ${this.key}`, phone: this.key === "A" ? "+447700900911" : "+447700900912", email: null, registration: null, consent: true }],
    });
    await this.rpc("finish_customer_import", { p_import_id: importId, p_status: "completed" });
    return importId;
  });

  /** An issued invoice (also creates invoice_items and invoice_number_sequences). */
  issuedInvoice = () => this.once("issuedInvoice", async () => {
    const draftId = String(await this.rpc("save_invoice_draft", {
      p_invoice_id: null,
      p_payload: invoiceDraftPayload("2096-04-01", this.tag("invoice")),
      p_confirm_duplicate_source: false,
    }));
    const issued = await this.rpc<{ revision: number }>("issue_invoice", { p_invoice_id: draftId });
    return { id: draftId, revision: Number(issued.revision) };
  });

  invoicePayment = () => this.once("invoicePayment", async () => {
    const invoice = await this.issuedInvoice();
    await this.rpc("record_invoice_payment", {
      p_invoice_id: invoice.id,
      p_amount_pence: 100,
      p_paid_at: "2096-04-02T12:00:00.000Z",
      p_method: "card",
      p_reference: this.tag("payment"),
    });
  });

  /** Claims an email send (invoice_email_sends + invoice_email_attempts); after the payment, which a pending send would block. */
  /** P5.10: an accounting connection (and its encrypted-token row) through the service-role function. */
  accountingConnection = () => this.once("accountingConnection", async () => {
    const sealed = `v1.${"a".repeat(16)}.${"b".repeat(22)}.${this.key.toLowerCase()}${localRunId}`;
    const { data, error } = await service.rpc("accounting_save_connection", {
      p_garage_id: this.garage.id,
      p_provider: "xero",
      p_tenant_id: `tenancy-org-${this.key}`,
      p_tenant_name: `Tenancy Org ${this.key}`,
      p_scopes: ["accounting.transactions"],
      p_connected_by: this.ownerId,
      p_access_token_ct: sealed,
      p_refresh_token_ct: sealed,
      p_expires_at: "2096-04-01T00:30:00.000Z",
    });
    if (error || !data) throw new Error(`fixture accounting connection (garage ${this.key}): ${error?.message ?? "no row returned"}`);
    return String((data as { id: string }).id);
  });

  invoiceEmail = () => this.once("invoiceEmail", async () => {
    const invoice = await this.issuedInvoice();
    await this.invoicePayment();
    const current = await this.owner.from("invoices").select("revision").eq("id", invoice.id).single();
    if (current.error || !current.data) throw new Error(`fixture invoice revision (garage ${this.key}): ${current.error?.message}`);
    await this.rpc("claim_invoice_email_send", {
      p_invoice_id: invoice.id,
      p_recipient: `${this.tag("invoice-email")}@example.test`,
      p_logical_send_id: randomUUID(),
      p_invoice_revision: Number(current.data.revision),
      p_payload_sha256: "c".repeat(64),
    });
  });
}

type Fixture = {
  /** Creates at least one row of the table in this garage. */
  create: (rows: GarageRows) => Promise<unknown>;
  /** Columns for the cross-garage update probe (a change, never a no-op). */
  patch: Record<string, unknown>;
};

/** P5.11: a service plan and one subscription per car per status (one live subscription per car). */
async function servicePlanSubscription(rows: GarageRows, status: "pending_mandate" | "cancelled" = "cancelled") {
  const plan = await rows.insert("service_plans", { name: `Tenancy plan ${rows.key} ${status}`, price_pence: 1500, discount_percent: 5 }, "id");
  return rows.insert("customer_plan_subscriptions", {
    plan_id: plan.id,
    customer_id: await rows.customer(),
    vehicle_id: await rows.vehicle(),
    status,
    price_pence: 1500,
    provider: "mock",
    ...(status === "cancelled" ? { cancelled_at: "2096-04-01T09:00:00.000Z" } : {}),
  }, "id");
}

const FIXTURES: Record<string, Fixture> = {
  agent_call_log: {
    create: async (rows) => rows.insert("agent_call_log", {
      token_id: await rows.agentToken(),
      tool: "list_services",
      outcome: "OK",
      http_status: 200,
      latency_ms: 12,
    }),
    patch: { outcome: "TAMPERED" },
  },
  agent_tokens: { create: (rows) => rows.agentToken(), patch: { revoked_at: "2096-04-01T00:00:00.000Z" } },
  ai_front_desk_settings: { create: (rows) => rows.insert("ai_front_desk_settings", { enabled: false }), patch: { enabled: true } },
  // D22: the garage's AI desk number state, written by the numbers.provision job (service role) only.
  ai_front_desk_numbers: { create: (rows) => rows.insert("ai_front_desk_numbers", { status: "waiting_upgrade" }), patch: { status: "ready" } },
  accounting_connections: { create: (rows) => rows.accountingConnection(), patch: { tenant_name: "Tampered" } },
  accounting_connection_secrets: { create: (rows) => rows.accountingConnection(), patch: { expires_at: "2096-04-02T00:00:00.000Z" } },
  accounting_sync_items: {
    create: async (rows) => rows.insert("accounting_sync_items", { connection_id: await rows.accountingConnection(), entity: "invoice", local_id: randomUUID() }),
    patch: { status: "failed", last_error_code: "TAMPERED" },
  },
  admin_audit_log: {
    create: (rows) => rows.insert("admin_audit_log", { actor_id: rows.ownerId, action: "tenancy.probe", entity_type: "tenancy", entity_id: rows.garage.id }),
    patch: { action: "tampered" },
  },
  // P5.7 fleet and trade accounts.
  account_statements: { create: (rows) => rows.accountStatement(), patch: { total_pence: 99 } },
  billing_usage_reports: {
    create: (rows) => rows.insert("billing_usage_reports", {
      period_month: "2096-04-01",
      metric: "sms_segments",
      plan: "pro",
      used: 12,
      allowance: 10,
      overage: 2,
    }),
    patch: { overage: 99 },
  },
  booking_audit_log: {
    create: async (rows) => rows.insert("booking_audit_log", { booking_id: await rows.booking(), action: "created", actor_type: "system" }),
    patch: { action: "tampered" },
  },
  booking_notification_events: {
    create: async (rows) => rows.insert("booking_notification_events", {
      notification_key: `tenancy:${rows.garage.id}:confirmed`,
      booking_id: await rows.booking(),
      notification_type: "confirmed",
    }),
    patch: { status: "failed" },
  },
  // P5.6: written only by assign_booking_technician(); staff have no update grant, so the probe is refused.
  booking_assignments: {
    create: async (rows) => rows.insert("booking_assignments", {
      booking_id: await rows.booking(),
      technician_id: rows.ownerId,
      technician_name: `Tenancy technician ${rows.key}`,
    }),
    patch: { technician_name: "Tampered" },
  },
  booking_events: {
    create: async (rows) => rows.insert("booking_events", {
      booking_id: await rows.booking(),
      type: "note",
      actor: "staff",
      actor_id: rows.ownerId,
      data: { text: `Tenancy probe ${rows.key}` },
    }),
    patch: { data: { tampered: true } },
  },
  bookings: { create: (rows) => rows.booking(), patch: { notes: "Tampered" } },
  campaigns: {
    create: (rows) => rows.insert("campaigns", { name: `Tenancy campaign ${rows.key}`, segment: {}, template: "{garage}: hi {link}", email_subject: "Tenancy" }),
    patch: { name: "Tampered" },
  },
  campaign_sends: {
    create: async (rows) => {
      const campaign = await rows.insert("campaigns", {
        name: `Tenancy sent ${rows.key}`,
        segment: {},
        template: "{garage}: hi {link}",
        email_subject: "Tenancy",
        status: "scheduled",
        send_at: "2096-04-03T09:00:00.000Z",
        recipients: 1,
        scheduled_at: "2096-04-01T09:00:00.000Z",
      }, "id");
      return rows.insert("campaign_sends", {
        campaign_id: campaign.id,
        customer_id: await rows.customer(),
        vehicle_id: await rows.vehicle(),
        channel: "sms",
        send_at: "2096-04-03T09:00:00.000Z",
      });
    },
    patch: { status: "cancelled", skip_reason: "tampered" },
  },
  business_account_bookings: {
    create: async (rows) => rows.insert("business_account_bookings", { booking_id: await rows.booking(), account_id: await rows.businessAccount(), po_number: `PO-${rows.key}` }),
    patch: { po_number: "TAMPERED" },
  },
  business_account_customers: {
    create: async (rows) => rows.insert("business_account_customers", { account_id: await rows.businessAccount(), customer_id: await rows.customer(), role: "driver" }),
    patch: { role: "contact" },
  },
  business_account_invoices: {
    create: async (rows) => rows.insert("business_account_invoices", {
      invoice_id: (await rows.issuedInvoice()).id,
      account_id: await rows.businessAccount(),
      bill_to_name: `Tenancy Fleet ${rows.key}`,
      statement_id: await rows.accountStatement(),
    }),
    patch: { po_number: "TAMPERED" },
  },
  business_account_vehicles: {
    create: async (rows) => rows.insert("business_account_vehicles", { account_id: await rows.businessAccount(), vehicle_id: await rows.vehicle() }),
    patch: { created_at: "2096-04-01T00:00:00.000Z" },
  },
  business_accounts: { create: (rows) => rows.businessAccount(), patch: { notes: "Tampered" } },
  closures: {
    create: (rows) => rows.insert("closures", { starts_on: "2096-12-25", ends_on: "2096-12-26", reason: `Tenancy probe ${rows.key}` }),
    patch: { reason: "Tampered" },
  },
  // P5.8: van legs, loans and requests are written only by their functions (no staff write grants).
  collection_delivery_legs: {
    create: async (rows) => rows.insert("collection_delivery_legs", {
      booking_id: await rows.booking(),
      leg: "collection",
      status: "unassigned",
      during: "[2096-04-02T08:00:00.000Z,2096-04-02T09:00:00.000Z)",
      postcode: "DN4 5AA",
      address: `Tenancy probe ${rows.key}`,
    }),
    patch: { address: "Tampered" },
  },
  courtesy_cars: {
    create: (rows) => rows.insert("courtesy_cars", { name: `Tenancy car ${rows.key}`, registration: `CC${rows.key}${localRunId.slice(0, 4)}`.toUpperCase() }),
    patch: { name: "Tampered" },
  },
  courtesy_car_loans: {
    create: async (rows) => {
      const car = await rows.insert("courtesy_cars", { name: `Tenancy loan car ${rows.key}`, registration: `CL${rows.key}${localRunId.slice(0, 4)}`.toUpperCase() }, "id");
      return rows.insert("courtesy_car_loans", {
        car_id: car.id,
        booking_id: await rows.booking(),
        customer_id: await rows.customer(),
        during: "[2096-04-02T09:00:00.000Z,2096-04-02T17:30:00.000Z)",
        notes: `Tenancy probe ${rows.key}`,
      });
    },
    patch: { notes: "Tampered" },
  },
  courtesy_car_requests: {
    create: async (rows) => rows.insert("courtesy_car_requests", { booking_id: await rows.booking(), customer_id: await rows.customer() }),
    patch: { reason: "Tampered" },
  },
  // Written only by the import RPCs; staff have no update grant, so the probe is refused.
  customer_imports: { create: (rows) => rows.customerImport(), patch: { file_name: "tampered.csv" } },
  customer_plan_subscriptions: { create: (rows) => servicePlanSubscription(rows, "pending_mandate"), patch: { status: "active", started_at: "2096-04-01T09:00:00.000Z" } },
  customers: { create: (rows) => rows.customer(), patch: { name: "Tampered" } },
  enquiries: { create: (rows) => rows.enquiry(), patch: { description: "Tampered" } },
  enquiry_attachments: {
    create: async (rows) => {
      const enquiryId = await rows.enquiry();
      return rows.insert("enquiry_attachments", {
        enquiry_id: enquiryId,
        enquiry_message_id: await rows.enquiryMessage(),
        object_path: `${rows.garage.id}/enquiries/${enquiryId}/probe.png`,
        file_name: "probe.png",
        content_type: "image/png",
        size_bytes: PNG.length,
      });
    },
    patch: { file_name: "tampered.png" },
  },
  enquiry_conversations: {
    create: async (rows) => rows.insert("enquiry_conversations", { enquiry_id: await rows.enquiry(), subject: `Tenancy probe ${rows.key}` }),
    patch: { subject: "Tampered subject" },
  },
  enquiry_messages: { create: (rows) => rows.enquiryMessage(), patch: { text_body: "Tampered" } },
  garage_agreements: {
    create: (rows) => rows.insert("garage_agreements", {
      kind: "dpa",
      version: "0.1",
      text_hash: "a".repeat(64),
      accepted_by: rows.ownerId,
      accepted_by_name: `Tenancy owner ${rows.key}`,
      accepted_by_role: "owner",
    }),
    patch: { version: "9.9" },
  },
  garage_domains: {
    create: async (rows) => {
      await rows.insert("garage_domains", { hostname: `book.${rows.garage.slug}.example`, kind: "custom", status: "pending_dns" });
      return rows.insert("garage_domains", { hostname: `${rows.garage.slug}.autofix.vitalos.co.uk`, kind: "subdomain", status: "active" });
    },
    patch: { deleted_at: "2096-04-01T00:00:00.000Z" },
  },
  // Written only by the invite functions; staff have no update grant, so the probe is refused.
  garage_invites: {
    create: (rows) => rows.insert("garage_invites", {
      email: `tenancy-invite-${rows.key.toLowerCase()}-${localRunId}@example.test`,
      role: "technician",
      token_hash: createHash("sha256").update(`tenancy-invite:${rows.garage.id}:${localRunId}`).digest("hex"),
      invited_by: rows.ownerId,
      expires_at: "2096-04-01T00:00:00.000Z",
    }),
    patch: { role: "manager" },
  },
  // Rows come from provisioning (owner, manager, technician, shared manager).
  // P5.9 groups: garage_id is the group's home garage. Each test garage is the home of its own group.
  garage_groups: { create: (rows) => rows.homeGroup(), patch: { name: "Tampered" } },
  // P5.9: garage_id is the site (here the home garage's own site row).
  garage_group_sites: {
    create: async (rows) => rows.insert("garage_group_sites", { group_id: await rows.homeGroup(), home_garage_id: rows.garage.id }),
    patch: { added_at: "2096-04-01T00:00:00.000Z" },
  },
  garage_members: { create: async () => undefined, patch: { role: "manager" } },
  garage_subscriptions: {
    create: (rows) => rows.insert("garage_subscriptions", { provider: "mock", status: "none", plan: "essentials" }),
    patch: { status: "active", plan: "pro" },
  },
  garage_phone_numbers: {
    create: (rows) => rows.insert("garage_phone_numbers", {
      number: rows.runNumber("78"),
      purpose: "forwarding",
      provider_sid: `PNtenancy${rows.key}${localRunId}`,
    }),
    patch: { purpose: "messaging" },
  },
  // P5.3 health checks: start_health_check() (idempotent per booking) creates the check and its checklist.
  health_checks: {
    create: async (rows) => rows.rpc("start_health_check", { p_booking_id: await rows.booking() }),
    patch: { summary: "Tampered" },
  },
  health_check_items: {
    create: async (rows) => rows.rpc("start_health_check", { p_booking_id: await rows.booking() }),
    patch: { note: "Tampered" },
  },
  // Staff may insert and delete media rows (no update grant): the update probe is refused.
  health_check_media: {
    create: async (rows) => {
      const checkId = String(await rows.rpc("start_health_check", { p_booking_id: await rows.booking() }));
      return rows.insert("health_check_media", {
        check_id: checkId,
        object_path: `${rows.garage.id}/health-checks/${checkId}/${randomUUID()}.png`,
        content_type: "image/png",
        size_bytes: PNG.length,
        kind: "image",
      });
    },
    patch: { content_type: "image/jpeg" },
  },
  invoice_email_attempts: { create: (rows) => rows.invoiceEmail(), patch: { status: "failed" } },
  invoice_email_sends: { create: (rows) => rows.invoiceEmail(), patch: { status: "failed" } },
  invoice_items: { create: (rows) => rows.issuedInvoice(), patch: { description: "Tampered" } },
  invoice_number_sequences: { create: (rows) => rows.issuedInvoice(), patch: { last_value: 999_999 } },
  invoice_payments: { create: (rows) => rows.invoicePayment(), patch: { amount_pence: 1 } },
  invoices: { create: (rows) => rows.issuedInvoice(), patch: { notes: "Tampered" } },
  // Platform queue with an optional garage_id (service role only): staff get 42501 on every probe.
  jobs: {
    create: (rows) => rows.insert("jobs", { kind: "tenancy.probe", payload: { garage: rows.key }, dedupe_key: `tenancy:${rows.garage.id}` }),
    patch: { status: "done" },
  },
  calls: { create: (rows) => rows.call(), patch: { handled_at: "2096-04-01T00:00:00.000Z" } },
  messages: {
    create: async (rows) => rows.insert("messages", {
      customer_id: await rows.customer(),
      call_id: await rows.call(),
      channel: "sms",
      direction: "outbound",
      to_address: rows.key === "A" ? "+447700900901" : "+447700900902",
      body: `Tenancy probe text ${rows.key}`,
      provider: "mock",
      provider_msg_id: `SMtenancy${rows.key}${localRunId}`,
      status: "sent",
    }),
    // Staff may only mark inbound messages read (20261028003000_messages_inbox.sql), and only their garage's.
    patch: { read_at: "2096-04-01T00:00:00.000Z" },
  },
  media_assets: {
    create: (rows) => rows.insert("media_assets", { object_path: `${rows.garage.id}/media/probe-${localRunId}.png`, alt_text: `Probe ${rows.key}` }),
    patch: { alt_text: "Tampered" },
  },
  notification_attempts: {
    create: async (rows) => rows.insert("notification_attempts", { enquiry_id: await rows.enquiry(), recipient_type: "business", status: "sent" }),
    patch: { error_code: "tampered" },
  },
  offers: {
    create: (rows) => rows.insert("offers", { title: `Probe offer ${rows.key}`, description: "Tenancy probe" }),
    patch: { title: "Tampered" },
  },
  opening_hours: {
    create: (rows) => rows.insert("opening_hours", { weekday: 1, opens: "08:00", closes: "17:30" }),
    patch: { closes: "18:00" },
  },
  reviews: {
    create: (rows) => rows.insert("reviews", {
      provider_review_id: `tenancy-${rows.key}-${localRunId}`,
      author_name: `Reviewer ${rows.key}`,
      rating: 5,
      text: "Tenancy probe review",
      source_uri: "https://example.test/review",
    }),
    patch: { text: "Tampered" },
  },
  // Super-admin impersonation sessions (P4.5, service role only): staff get 42501 on every probe.
  platform_impersonations: {
    create: (rows) => rows.insert("platform_impersonations", {
      admin_user_id: rows.ownerId,
      reason: `Tenancy probe ${rows.key}`,
      started_at: "2096-04-01T09:00:00.000Z",
      expires_at: "2096-04-01T09:30:00.000Z",
      ended_at: "2096-04-01T09:10:00.000Z",
      end_reason: "ended",
    }),
    patch: { reason: "Tampered reason" },
  },
  payment_accounts: {
    create: (rows) => rows.insert("payment_accounts", { provider: "mock", account_ref: `mock_acct_tenancy_${rows.key}`, status: "active", charges_enabled: true }),
    patch: { status: "disconnected" },
  },
  payment_settings: {
    create: (rows) => rows.insert("payment_settings", { deposits_enabled: true, default_deposit_mode: "fixed", default_deposit_value: 2000, no_show_fee_pence: 2500 }),
    patch: { no_show_fee_pence: 9999 },
  },
  payments: {
    create: async (rows) => rows.insert("payments", {
      kind: "no_show_fee",
      amount_pence: 2500,
      description: `Tenancy probe ${rows.key}`,
      booking_id: await rows.booking(),
      customer_id: await rows.customer(),
      token_hash: createHash("sha256").update(`payment-${rows.key}-${localRunId}`).digest("hex"),
      expires_at: "2096-04-20T09:00:00.000Z",
      provider: "mock",
    }),
    patch: { status: "cancelled" },
  },
  plan_requests: {
    create: (rows) => rows.insert("plan_requests", { requested_plan: "pro", requested_by: rows.ownerId, note: `Tenancy probe ${rows.key}` }),
    patch: { status: "done" },
  },
  reminder_rules: { create: (rows) => rows.reminderRule(), patch: { template: "Tampered {link}" } },
  reminder_sends: {
    create: async (rows) => rows.insert("reminder_sends", {
      rule_id: await rows.reminderRule(),
      vehicle_id: await rows.vehicle(),
      customer_id: await rows.customer(),
      kind: "mot",
      due_date: "2096-05-01",
      offset_days: 28,
      send_at: "2096-04-03T09:00:00.000Z",
      channel: "sms",
    }),
    patch: { status: "cancelled", skip_reason: "tampered" },
  },
  resources: { create: (rows) => rows.resource(), patch: { name: "Tampered" } },
  services: { create: (rows) => rows.service(), patch: { name: "Tampered" } },
  service_plans: { create: (rows) => rows.insert("service_plans", { name: `Tenancy plan ${rows.key}`, price_pence: 1500, discount_percent: 5 }), patch: { name: "Tampered" } },
  service_plan_inclusions: {
    create: async (rows) => {
      const plan = await rows.insert("service_plans", { name: `Tenancy inclusion plan ${rows.key}`, price_pence: 1500 }, "id");
      return rows.insert("service_plan_inclusions", { plan_id: plan.id, service_id: await rows.service(), uses_per_year: 1 });
    },
    patch: { uses_per_year: 12 },
  },
  service_plan_uses: {
    create: async (rows) => {
      const subscription = await servicePlanSubscription(rows);
      return rows.insert("service_plan_uses", {
        subscription_id: subscription.id,
        booking_id: await rows.booking(),
        service_id: await rows.service(),
        plan_year_start: "2096-04-01T09:00:00.000Z",
        source: "staff",
      });
    },
    patch: { status: "released", released_at: "2096-04-02T09:00:00.000Z" },
  },
  service_plan_invoice_applications: {
    create: async (rows) => {
      const subscription = await servicePlanSubscription(rows);
      return rows.insert("service_plan_invoice_applications", { invoice_id: (await rows.issuedInvoice()).id, subscription_id: subscription.id, discount_pence: 100 });
    },
    patch: { discount_pence: 99999 },
  },
  service_prices: {
    create: (rows) => rows.insert("service_prices", { service_slug: "tenancy-probe", minimum: 1000, maximum: 2000, label: `Probe ${rows.key}` }),
    patch: { label: "Tampered" },
  },
  site_settings: {
    create: (rows) => rows.insert("site_settings", { value: { tenancyProbe: rows.key } }),
    patch: { value: { tampered: true } },
  },
  usage_events: {
    create: (rows) => rows.insert("usage_events", {
      metric: "sms_segments",
      quantity: 2,
      period_month: "2096-04-01",
      occurred_at: "2096-04-02T10:00:00.000Z",
      source_key: `tenancy:${rows.key}:${localRunId}`,
    }),
    patch: { quantity: 99 },
  },
  vehicles: { create: (rows) => rows.vehicle(), patch: { make: "Tampered" } },
};

// ---------------------------------------------------------------------------
// Run state (filled in by beforeAll)
// ---------------------------------------------------------------------------

type RunState = {
  garages: Record<GarageKey, LocalTestGarage>;
  identities: Record<"ownerA" | "managerA" | "technicianA" | "ownerB" | "shared", LocalTestIdentity>;
  actors: Record<ActorKey, Actor>;
  /** Fingerprints taken after the fixtures and before any probe. */
  before: Map<string, Fingerprint>;
  storagePaths: Record<GarageKey, { media: string; attachment: string }>;
};

let state: RunState | undefined;

function run(): RunState {
  if (!state) throw new Error("Tenancy fixtures were not provisioned (see the beforeAll error above)");
  return state;
}

function garageId(key: GarageKey) {
  return run().garages[key].id;
}

function actor(key: ActorKey) {
  return run().actors[key];
}

async function fingerprint(table: string, key: GarageKey): Promise<Fingerprint> {
  const [row] = await rpcRows<{ row_count: number | string; checksum: string }>("tenancy_fingerprint", { p_table: table, p_garage_id: garageId(key) });
  if (!row) throw new Error(`No fingerprint for ${table}`);
  return { row_count: Number(row.row_count), checksum: row.checksum };
}

async function storageFingerprint(key: GarageKey): Promise<Fingerprint> {
  const [row] = await rpcRows<{ row_count: number | string; checksum: string }>("tenancy_storage_fingerprint", { p_garage_id: garageId(key) });
  if (!row) throw new Error("No storage fingerprint");
  return { row_count: Number(row.row_count), checksum: row.checksum };
}

const missingFixtures = () => garageTables.filter((table) => !FIXTURES[table]);

function assertFixturesCoverEveryTable() {
  const missing = missingFixtures();
  if (missing.length) {
    throw new Error(`no fixture for table ${missing.join(", ")}: add an entry to FIXTURES in tests/integration/tenancy.test.ts`);
  }
}

async function provision(): Promise<RunState> {
  assertFixturesCoverEveryTable();
  const garages = { A: await createLocalGarage(service, "ta"), B: await createLocalGarage(service, "tb") };
  const email = (name: string) => `tenancy-${name}-${localRunId}@example.test`;
  // Owners hold verified TOTP factors (AAL2): mandatory owner MFA stays on, as shipped.
  const identities = {
    ownerA: await createLocalMfaIdentity(service, config.publishableKey, email("owner-a")),
    managerA: await createLocalIdentity(service, config.publishableKey, email("manager-a")),
    technicianA: await createLocalIdentity(service, config.publishableKey, email("technician-a")),
    ownerB: await createLocalMfaIdentity(service, config.publishableKey, email("owner-b")),
    shared: await createLocalIdentity(service, config.publishableKey, email("shared")),
  };
  const members = await service.from("garage_members").insert([
    { garage_id: garages.A.id, user_id: identities.ownerA.id, role: "owner" },
    { garage_id: garages.A.id, user_id: identities.managerA.id, role: "manager" },
    { garage_id: garages.A.id, user_id: identities.technicianA.id, role: "technician" },
    { garage_id: garages.A.id, user_id: identities.shared.id, role: "manager" },
    { garage_id: garages.B.id, user_id: identities.ownerB.id, role: "owner" },
    { garage_id: garages.B.id, user_id: identities.shared.id, role: "manager" },
  ]);
  if (members.error) throw new Error(`Could not add garage members: ${members.error.message}`);
  const profiles = await service.from("admin_profiles").upsert(
    Object.entries(identities).map(([name, identity]) => ({ user_id: identity.id, display_name: `Tenancy ${name}` })),
  );
  if (profiles.error) throw new Error(`Could not add staff profiles: ${profiles.error.message}`);
  const unmatched = await service.from("unmatched_inbound_emails").insert({
    provider_email_id: `tenancy-${localRunId}`,
    sender_email: "someone@example.test",
    subject: "Unmatched tenancy probe",
    text_body: "Platform-level row; garage staff must not read it.",
    reason: "no_thread",
  });
  if (unmatched.error) throw new Error(`Could not add an unmatched inbound email: ${unmatched.error.message}`);

  const key = config.publishableKey;
  const actors = {} as Record<ActorKey, Actor>;
  const clients: Record<ActorKey, [SupabaseClient, string | null]> = {
    anon: [createLocalClient(key), null],
    anonForgingA: [createLocalClient(key, undefined, garages.A.id), null],
    ownerA: [createLocalClient(key, identities.ownerA.accessToken, garages.A.id), identities.ownerA.id],
    managerA: [createLocalClient(key, identities.managerA.accessToken, garages.A.id), identities.managerA.id],
    technicianA: [createLocalClient(key, identities.technicianA.accessToken, garages.A.id), identities.technicianA.id],
    ownerB: [createLocalClient(key, identities.ownerB.accessToken, garages.B.id), identities.ownerB.id],
    ownerBForgingA: [createLocalClient(key, identities.ownerB.accessToken, garages.A.id), identities.ownerB.id],
    ownerBNoHeader: [createLocalClient(key, identities.ownerB.accessToken), identities.ownerB.id],
    sharedWithA: [createLocalClient(key, identities.shared.accessToken, garages.A.id), identities.shared.id],
  };
  for (const spec of ACTORS) {
    const [client, userId] = clients[spec.key];
    actors[spec.key] = { ...spec, client, userId };
  }

  // Rows in every garage table, in both garages.
  const rowsByGarage = {
    A: new GarageRows(garages.A, actors.ownerA.client, identities.ownerA.id, "A"),
    B: new GarageRows(garages.B, actors.ownerB.client, identities.ownerB.id, "B"),
  };
  for (const table of garageTables) {
    const fixture = FIXTURES[table]!;
    await fixture.create(rowsByGarage.A);
    await fixture.create(rowsByGarage.B);
  }

  // Storage objects under each garage's folder in both buckets.
  const storagePaths = {
    A: { media: `${garages.A.id}/tenancy/${localRunId}.png`, attachment: `${garages.A.id}/tenancy/${localRunId}.png` },
    B: { media: `${garages.B.id}/tenancy/${localRunId}.png`, attachment: `${garages.B.id}/tenancy/${localRunId}.png` },
  };
  for (const garageKey of ["A", "B"] as const) {
    const media = await service.storage.from("public-media").upload(storagePaths[garageKey].media, PNG, { contentType: "image/png" });
    if (media.error) throw new Error(`Could not upload a media fixture: ${media.error.message}`);
    const attachment = await service.storage.from("enquiry-attachments").upload(storagePaths[garageKey].attachment, PNG, { contentType: "image/png" });
    if (attachment.error) throw new Error(`Could not upload an attachment fixture: ${attachment.error.message}`);
  }

  state = { garages, identities, actors, before: new Map(), storagePaths };
  for (const table of [...garageTables, "garages"]) {
    for (const garageKey of ["A", "B"] as const) {
      const print = await fingerprint(table, garageKey);
      if (table !== "garages" && print.row_count < 1) throw new Error(`fixture ${table} created no rows in garage ${garageKey}`);
      state.before.set(`${table}:${garageKey}`, print);
    }
  }
  for (const garageKey of ["A", "B"] as const) state.before.set(`storage:${garageKey}`, await storageFingerprint(garageKey));
  return state;
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

type PostgrestOutcome = { error: { code?: string; message: string } | null; count?: number | null; data?: unknown };

/** The request was refused outright (42501), or it touched exactly zero rows. */
function expectDeniedOrZero(result: PostgrestOutcome, what: string) {
  if (result.error) {
    expect(result.error.code, `${what}: ${result.error.message}`).toBe("42501");
    return;
  }
  expect(result.count, `${what}: affected-row count`).toBe(0);
}

/** A copy of one of the victim garage's rows, limited to columns staff may insert. */
async function insertPayload(table: string, victim: GarageKey): Promise<Record<string, unknown>> {
  const meta = tableMeta(table);
  const { data, error } = await service.rpc("tenancy_sample_row", { p_table: table, p_garage_id: garageId(victim) });
  if (error || !data) throw new Error(`No sample row for ${table}: ${error?.message}`);
  const sample = data as Record<string, unknown>;
  const staffMayInsert = meta.authenticated_privileges.includes("INSERT");
  const payload: Record<string, unknown> = {};
  for (const column of meta.columns) {
    if (column.identity || column.generated) continue;
    if (staffMayInsert && !column.authenticated_insert) continue;
    // A fresh primary key, so only the garage check can stop the copy.
    if (meta.primary_key.includes(column.name) && column.has_default && column.name !== "garage_id") continue;
    if (column.name in sample) payload[column.name] = sample[column.name];
  }
  payload.garage_id = garageId(victim);
  return payload;
}

const CURRENT_GARAGE = /current_garage_id\(\)/;

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("tenancy structure", () => {
  it("discovers the garage tables from information_schema", () => {
    expect(garageTables.length).toBeGreaterThanOrEqual(10);
    expect(garageTables).toEqual(expect.arrayContaining(["customers", "vehicles", "garage_members", "garage_domains", "site_settings"]));
  });

  it("has a fixture for every garage table", () => {
    expect(missingFixtures(), "no fixture for table").toEqual([]);
  });

  it("no policy on public tables or storage.objects applies to anon or public", () => {
    const open = policies.filter((policy) => policy.roles.some((role) => role === "anon" || role === "public"));
    expect(open.map((policy) => `${policy.schema_name}.${policy.table_name}: ${policy.policy_name}`)).toEqual([]);
  });

  it("anon can execute no function in public", () => {
    expect(functionGrants.filter((grant) => grant.anon_execute).map((grant) => grant.signature)).toEqual([]);
  });

  it("the tenancy test helpers are service-role only", () => {
    const helpers = functionGrants.filter((grant) => grant.signature.startsWith("public.tenancy_"));
    expect(helpers.length).toBeGreaterThanOrEqual(6);
    expect(helpers.filter((grant) => grant.anon_execute || grant.authenticated_execute).map((grant) => grant.signature)).toEqual([]);
  });

  it("views in public are security_invoker or closed to API roles", () => {
    const leaky = catalog
      .filter((table) => !BASE_TABLE_KINDS.has(table.table_kind))
      .filter((table) => table.anon_privileges.length > 0
        || (table.authenticated_privileges.length > 0 && !(table.table_kind === "view" && table.security_invoker)));
    expect(leaky.map((table) => `${table.table_kind} ${table.table_name}`)).toEqual([]);
  });

  it("storage.objects policies stay inside the selected garage's folder", () => {
    const storagePolicies = policiesOn("storage", "objects");
    expect(storagePolicies.length).toBeGreaterThan(0);
    for (const policy of storagePolicies) {
      for (const expression of [policy.using_expression, policy.check_expression]) {
        if (expression === null) continue;
        expect(expression, `${policy.policy_name}`).toMatch(CURRENT_GARAGE);
        expect(expression, `${policy.policy_name}`).toMatch(/foldername\(name\)\)\[1\]/);
      }
    }
  });

  describe.each(garageTables)("%s", (table) => {
    const meta = tableMeta(table);
    const tablePolicies = policiesOn("public", table);

    it("has RLS enabled", () => {
      expect(meta.rls_enabled).toBe(true);
    });

    it("scopes every policy expression by current_garage_id()", () => {
      for (const policy of tablePolicies) {
        expect(policy.roles, policy.policy_name).toEqual(["authenticated"]);
        if (policy.using_expression !== null) expect(policy.using_expression, `${policy.policy_name} USING`).toMatch(CURRENT_GARAGE);
        if (policy.check_expression !== null) expect(policy.check_expression, `${policy.policy_name} WITH CHECK`).toMatch(CURRENT_GARAGE);
      }
    });

    it("grants anon nothing", () => {
      expect(meta.anon_privileges).toEqual([]);
    });

    it("has no table-wide TRUNCATE, REFERENCES or TRIGGER for staff", () => {
      expect(meta.authenticated_privileges.filter((privilege) => ["TRUNCATE", "REFERENCES", "TRIGGER"].includes(privilege))).toEqual([]);
    });

    it("update probe uses columns staff may update", () => {
      const fixture = FIXTURES[table];
      if (!fixture) throw new Error(`no fixture for table ${table}`);
      if (!meta.authenticated_privileges.includes("UPDATE")) return;
      const updatable = new Set(meta.columns.filter((column) => column.authenticated_update).map((column) => column.name));
      expect(Object.keys(fixture.patch).filter((column) => !updatable.has(column))).toEqual([]);
    });
  });
});

describe("platform tables without garage_id (A10)", () => {
  // Signed-in staff may read only these, and only as their policies allow.
  const allowed: Record<string, { privileges: string[]; helper: RegExp }> = {
    admin_profiles: { privileges: ["SELECT", "UPDATE"], helper: /auth\.uid\(\)/ },
    unmatched_inbound_emails: { privileges: ["SELECT", "UPDATE"], helper: /is_platform_admin\(\)/ },
  };

  it("garages: staff select and update only through membership policies", () => {
    const meta = tableMeta("garages");
    expect(meta.rls_enabled).toBe(true);
    expect(meta.anon_privileges).toEqual([]);
    expect(meta.authenticated_privileges).toEqual(["SELECT", "UPDATE"]);
    for (const policy of policiesOn("public", "garages")) {
      for (const expression of [policy.using_expression, policy.check_expression]) {
        if (expression !== null) expect(expression, policy.policy_name).toMatch(/garage_role\(id\)|current_garage_id\(\)/);
      }
    }
  });

  describe.each(platformTables)("%s", (table) => {
    const meta = tableMeta(table);

    it("has RLS enabled and grants anon nothing", () => {
      expect(meta.rls_enabled).toBe(true);
      expect(meta.anon_privileges).toEqual([]);
    });

    it(allowed[table] ? "is readable by staff only through its documented policy" : "is not readable by signed-in staff", () => {
      const rule = allowed[table];
      if (!rule) {
        expect(meta.authenticated_privileges).toEqual([]);
        return;
      }
      expect(meta.authenticated_privileges).toEqual(rule.privileges);
      const tablePolicies = policiesOn("public", table);
      expect(tablePolicies.length).toBeGreaterThan(0);
      for (const policy of tablePolicies) {
        if (policy.using_expression !== null) expect(policy.using_expression, policy.policy_name).toMatch(rule.helper);
        if (policy.check_expression !== null) expect(policy.check_expression, policy.policy_name).toMatch(rule.helper);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

describe("tenancy isolation", () => {
  beforeAll(async () => {
    await provision();
  }, 180_000);

  // Platform rows have no garage to scope them, so remove the one this run
  // added (other suites count that table). Garage rows stay, as in the other
  // integration suites; they belong to this run's garages only.
  afterAll(async () => {
    const removed = await service.from("unmatched_inbound_emails").delete().eq("provider_email_id", `tenancy-${localRunId}`);
    if (removed.error) throw new Error(`Could not remove the unmatched inbound email fixture: ${removed.error.message}`);
  });

  describe.each(garageTables)("%s", (table) => {
    const meta = tableMeta(table);

    for (const spec of ACTORS) {
      const victim = spec.victim;

      it(`${spec.label} cannot select garage ${victim} rows`, async () => {
        const subject = actor(spec.key);
        const result = await subject.client.from(table).select("*", { count: "exact" }).eq("garage_id", garageId(victim));
        if (result.error) {
          expect(result.error.code, result.error.message).toBe("42501");
          return;
        }
        const rows = (result.data ?? []) as Record<string, unknown>[];
        if (table === "garage_members" && subject.userId) {
          // Documented exception (tenancy migration, garage_members policy):
          // a user always sees their own memberships, in every garage, for the
          // garage switcher. Nobody else's.
          expect(rows.every((row) => row.user_id === subject.userId)).toBe(true);
          expect(rows.length).toBeLessThanOrEqual(1);
          return;
        }
        expect(rows).toEqual([]);
        expect(result.count).toBe(0);
      });

      it(`${spec.label} cannot insert into garage ${victim}`, async () => {
        const subject = actor(spec.key);
        const payload = await insertPayload(table, victim);
        const explicit = await subject.client.from(table).insert(payload);
        expect(explicit.error?.code, `insert with garage_id ${victim}: ${explicit.error?.message ?? "succeeded"}`).toBe("42501");
        // Without a selected garage (anon, a forged header, no header) the
        // column default current_garage_id() is null, so leaving garage_id out
        // must fail too. (A member with a garage selected would legitimately
        // insert into that garage, so they are not probed this way.)
        if (spec.selected === undefined) {
          const withoutGarage = Object.fromEntries(Object.entries(payload).filter(([column]) => column !== "garage_id"));
          const defaulted = await subject.client.from(table).insert(withoutGarage);
          expect(defaulted.error?.code, `insert with the default garage_id: ${defaulted.error?.message ?? "succeeded"}`).toBe("42501");
        }
      });

      it(`${spec.label} cannot update garage ${victim} rows`, async () => {
        const subject = actor(spec.key);
        const fixture = FIXTURES[table];
        if (!fixture) throw new Error(`no fixture for table ${table}`);
        const result = await subject.client.from(table).update(fixture.patch, { count: "exact" }).eq("garage_id", garageId(victim));
        expectDeniedOrZero(result, `update ${table}`);
      });

      it(`${spec.label} cannot delete garage ${victim} rows`, async () => {
        const subject = actor(spec.key);
        const result = await subject.client.from(table).delete({ count: "exact" }).eq("garage_id", garageId(victim));
        expectDeniedOrZero(result, `delete ${table}`);
      });

      it(`${spec.label} cannot move garage ${other(victim)} rows into garage ${victim}`, async () => {
        const subject = actor(spec.key);
        const result = await subject.client
          .from(table)
          .update({ garage_id: garageId(victim) }, { count: "exact" })
          .eq("garage_id", garageId(other(victim)));
        expectDeniedOrZero(result, `move ${table}`);
      });
    }

    for (const spec of ACTORS.filter((candidate) => candidate.selected)) {
      const own = spec.selected!;
      const staffMayRead = meta.authenticated_privileges.includes("SELECT");
      it(staffMayRead
        ? `${spec.label} reads its own garage ${own} rows (positive control)`
        : `${spec.label} has no direct read access (no SELECT grant)`, async () => {
        // GET rather than HEAD, so a refusal carries its error code.
        const result = await actor(spec.key).client.from(table).select("garage_id", { count: "exact" }).eq("garage_id", garageId(own)).limit(1);
        if (!staffMayRead) {
          expect(result.error?.code).toBe("42501");
          return;
        }
        expect(result.error).toBeNull();
        const limitedTo = ROLE_LIMITED_READS[table];
        const role = ACTOR_ROLES[spec.key];
        if (limitedTo && (!role || !limitedTo.includes(role))) {
          expect(result.count).toBe(0);
          return;
        }
        expect(result.count).toBe(run().before.get(`${table}:${own}`)?.row_count);
      });
    }
  });

  describe("platform_calls (Autofix's own line, A420)", () => {
    // Calls to Autofix's own number belong to no garage: no member of any garage, and nobody signed
    // out, may read or touch them, whatever garage they have selected or forge.
    for (const spec of ACTORS) {
      it(`${spec.label} cannot select, insert, update or delete platform calls`, async () => {
        const client = actor(spec.key).client;
        expect((await client.from("platform_calls").select("id").limit(1)).error?.code).toBe("42501");
        const insert = await client.from("platform_calls").insert({ provider_call_sid: `tenancy-${localRunId}-${spec.key}`, to_number: "+441146974393" });
        expect(insert.error?.code).toBe("42501");
        expectDeniedOrZero(await client.from("platform_calls").update({ status: "completed" }, { count: "exact" }).neq("status", "completed"), "update platform_calls");
        expectDeniedOrZero(await client.from("platform_calls").delete({ count: "exact" }).neq("status", "never"), "delete platform_calls");
      });
    }
  });

  describe("garages", () => {
    it("anon cannot select, insert, update or delete garages", async () => {
      const client = actor("anon").client;
      expect((await client.from("garages").select("id").eq("id", garageId("A"))).error?.code).toBe("42501");
      expect((await client.from("garages").insert({ slug: `anon-${localRunId}`, name: "Anon", booking_prefix: "ANO" })).error?.code).toBe("42501");
      expect((await client.from("garages").update({ name: "Tampered" }).eq("id", garageId("A"))).error?.code).toBe("42501");
      expect((await client.from("garages").delete().eq("id", garageId("A"))).error?.code).toBe("42501");
    });

    for (const spec of ACTORS.filter((candidate) => !candidate.key.startsWith("anon"))) {
      const victim = spec.victim;
      it(`${spec.label} cannot change garage ${victim}`, async () => {
        const client = actor(spec.key).client;
        const update = await client.from("garages").update({ name: "Tampered" }, { count: "exact" }).eq("id", garageId(victim));
        expectDeniedOrZero(update, "update garages");
        const remove = await client.from("garages").delete({ count: "exact" }).eq("id", garageId(victim));
        expectDeniedOrZero(remove, "delete garages");
        const create = await client.from("garages").insert({ slug: `planted-${spec.key.toLowerCase()}-${localRunId}`, name: "Planted", booking_prefix: "PLT" });
        expect(create.error?.code).toBe("42501");
      });

      if (spec.key !== "sharedWithA") {
        it(`${spec.label} cannot see garage ${victim}`, async () => {
          const result = await actor(spec.key).client.from("garages").select("id", { count: "exact" }).eq("id", garageId(victim));
          expect(result.error).toBeNull();
          expect(result.data).toEqual([]);
        });
      }
    }

    it("A+B manager lists both garages for the switcher (documented)", async () => {
      const result = await actor("sharedWithA").client.from("garages").select("id").in("id", [garageId("A"), garageId("B")]);
      expect(result.error).toBeNull();
      expect(result.data?.map((row) => row.id).sort()).toEqual([garageId("A"), garageId("B")].sort());
    });

    it("A owner reads garage A (positive control)", async () => {
      const result = await actor("ownerA").client.from("garages").select("id").eq("id", garageId("A"));
      expect(result.data).toEqual([{ id: garageId("A") }]);
    });
  });

  describe("platform tables as signed-in staff", () => {
    for (const table of platformTables) {
      for (const key of ["anon", "ownerA", "ownerB", "sharedWithA"] as const) {
        it(`${table} › ${ACTORS.find((spec) => spec.key === key)!.label} reads nothing beyond its own rows`, async () => {
          const subject = actor(key);
          const result = await subject.client.from(table).select("*");
          if (result.error) {
            expect(result.error.code, result.error.message).toBe("42501");
            return;
          }
          const rows = (result.data ?? []) as Record<string, unknown>[];
          if (table === "admin_profiles") {
            expect(rows.map((row) => row.user_id)).toEqual([subject.userId]);
            return;
          }
          expect(rows).toEqual([]);
        });
      }
    }

    it("admin_profiles › B owner cannot rename A owner's profile", async () => {
      const result = await actor("ownerB").client
        .from("admin_profiles")
        .update({ display_name: "Tampered" }, { count: "exact" })
        .eq("user_id", run().identities.ownerA.id);
      expectDeniedOrZero(result, "update admin_profiles");
    });
  });

  describe("storage.objects", () => {
    const bucketPaths = (key: GarageKey) => run().storagePaths[key];

    for (const spec of ACTORS) {
      const victim = spec.victim;

      it(`${spec.label} cannot list garage ${victim}'s folders`, async () => {
        const client = actor(spec.key).client;
        for (const bucket of ["public-media", "enquiry-attachments"]) {
          const listed = await client.storage.from(bucket).list(`${garageId(victim)}/tenancy`);
          if (!listed.error) expect(listed.data, bucket).toEqual([]);
        }
      });

      it(`${spec.label} cannot download garage ${victim}'s private attachments`, async () => {
        const downloaded = await actor(spec.key).client.storage.from("enquiry-attachments").download(bucketPaths(victim).attachment);
        expect(downloaded.error).not.toBeNull();
        expect(downloaded.data).toBeNull();
      });

      it(`${spec.label} cannot upload into garage ${victim}'s folders`, async () => {
        const client = actor(spec.key).client;
        for (const bucket of ["public-media", "enquiry-attachments"]) {
          const planted = await client.storage.from(bucket).upload(`${garageId(victim)}/tenancy/planted-${spec.key}.png`, PNG, { contentType: "image/png" });
          expect(planted.error, `${bucket} new object`).not.toBeNull();
          const overwritten = await client.storage.from(bucket).upload(bucketPaths(victim).media, PNG, { contentType: "image/png", upsert: true });
          expect(overwritten.error, `${bucket} overwrite`).not.toBeNull();
        }
      });

      it(`${spec.label} cannot move, copy or delete garage ${victim}'s objects`, async () => {
        const client = actor(spec.key).client;
        const ownFolder = `${garageId(other(victim))}/tenancy`;
        for (const bucket of ["public-media", "enquiry-attachments"]) {
          const path = bucketPaths(victim).media;
          expect((await client.storage.from(bucket).move(path, `${garageId(victim)}/tenancy/moved-${spec.key}.png`)).error, `${bucket} move`).not.toBeNull();
          expect((await client.storage.from(bucket).copy(path, `${ownFolder}/copied-${spec.key}.png`)).error, `${bucket} copy`).not.toBeNull();
          const removed = await client.storage.from(bucket).remove([path]);
          if (!removed.error) expect(removed.data, `${bucket} remove`).toEqual([]);
        }
      });
    }

    it("A owner lists and downloads garage A's objects (positive control)", async () => {
      const client = actor("ownerA").client;
      const listed = await client.storage.from("public-media").list(`${garageId("A")}/tenancy`);
      expect(listed.error).toBeNull();
      expect(listed.data?.map((object) => object.name)).toContain(`${localRunId}.png`);
      const downloaded = await client.storage.from("enquiry-attachments").download(bucketPaths("A").attachment);
      expect(downloaded.error).toBeNull();
      expect(downloaded.data?.size).toBe(PNG.length);
    });
  });

  describe("integrity: the service role sees every garage's rows unchanged", () => {
    describe.each([...garageTables, "garages"])("%s", (table) => {
      for (const garageKey of ["A", "B"] as const) {
        it(`garage ${garageKey} rows are unchanged (count and checksum)`, async () => {
          expect(await fingerprint(table, garageKey)).toEqual(run().before.get(`${table}:${garageKey}`));
        });
      }
    });

    for (const garageKey of ["A", "B"] as const) {
      it(`storage objects under garage ${garageKey}'s folder are unchanged`, async () => {
        expect(await storageFingerprint(garageKey)).toEqual(run().before.get(`storage:${garageKey}`));
      });
    }
  });
});
