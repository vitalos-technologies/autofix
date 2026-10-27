import { describe, expect, it } from "vitest";
import {
  allMigrations,
  baselineMigration,
  functionDefinition,
  migrationFiles,
  schedulingMigration,
  sqlStatements,
  tenancyMigration,
} from "./support/migrations";

// Tables the tenancy migration (P1.4) scoped by garage. booking_service_types,
// service_catalogue_systems and provider_webhook_events were dropped again by
// the scheduling migration (asserted below).
const tenantTables = [
  "customers", "vehicles", "bookings", "booking_service_types", "service_catalogue_systems", "booking_audit_log",
  "booking_notification_events", "enquiries", "enquiry_attachments", "enquiry_conversations", "enquiry_messages",
  "notification_attempts", "invoices", "invoice_items", "invoice_payments", "invoice_email_sends",
  "invoice_email_attempts", "invoice_number_sequences", "media_assets", "reviews", "offers", "service_prices",
  "site_settings", "admin_audit_log",
];
const garageTables = ["garages", "garage_domains", "garage_members", "platform_admins"];
const platformTables = [
  "rate_limit_buckets", "resend_webhook_events", "inbound_email_events", "provider_webhook_events",
  "unmatched_inbound_emails", "admin_profiles", "admin_mfa_policy", "admin_mfa_recovery_codes",
  "admin_mfa_recovery_sessions", "admin_trusted_devices",
];
const removedSurfaces = ["content_entries", "content_revisions", "navigation_items", "sale_vehicles", "sale_vehicle_images", "import_article_drafts", "vehicle-sales"];
const serviceRoleFunctions = [
  "consume_rate_limit(text, text, integer, integer)",
  "claim_inbound_email_event(text, text, text)",
  "finish_inbound_email_event(text, text, text, text)",
  "replace_admin_mfa_recovery_codes(uuid, text[], text)",
  "consume_admin_mfa_recovery_code(uuid, text, text, timestamptz)",
  "generate_booking_reference(uuid)",
  "create_booking_enquiry_thread(uuid, uuid, uuid)",
  "increment_enquiry_unread(uuid, uuid, timestamptz)",
  "apply_enquiry_retention(uuid)",
  "finalize_invoice_email_send(uuid, bigint, uuid, text)",
  "fail_invoice_email_send(uuid, bigint, uuid, text, boolean, text)",
];
const tenancyStatements = sqlStatements(tenancyMigration);
const schedulingStatements = sqlStatements(schedulingMigration);
const schedulingTables = ["resources", "opening_hours", "closures", "services", "bookings", "booking_events"];
const engineFunctions = [
  "available_slots(uuid, uuid, date, date, text)",
  "seed_garage_defaults(uuid)",
];
const internalEngineFunctions = [
  "available_slots_at(uuid, uuid, date, date, text, timestamptz)",
  "opening_window_starts(uuid, date, date, integer)",
  "booking_service_context(uuid, uuid, text)",
  "maintain_booking_cancellation()",
  "log_booking_status_change()",
];

describe("Supabase migration security invariants", () => {
  it("starts from one SOB baseline followed by the tenancy migration", () => {
    expect(migrationFiles.slice(0, 2)).toEqual(["20261026000000_baseline.sql", "20261026000100_tenancy.sql"]);
    expect(baselineMigration).toMatch(/commit\s+(?:--\s+)?35496ff/);
  });

  it("leaves SOB-only surfaces out of the baseline", () => {
    const sqlWithoutComments = allMigrations.replace(/--[^\n]*/g, "");
    for (const surface of removedSurfaces) expect(sqlWithoutComments).not.toContain(surface);
  });

  it.each([...tenantTables, ...garageTables, ...platformTables])("enables RLS on %s", (table) => {
    expect(allMigrations).toContain(`alter table public.${table} enable row level security;`);
  });

  it.each(tenantTables)("adds a cascading, defaulted garage_id to %s", (table) => {
    expect(tenancyMigration).toMatch(new RegExp(
      `alter table public\\.${table}\\n(?:  [^\\n]*\\n)*?  add column garage_id uuid not null default public\\.current_garage_id\\(\\) references public\\.garages\\(id\\) on delete cascade`,
    ));
  });

  it("scopes every tenant policy to the selected garage", () => {
    const policies = tenancyStatements.filter((statement) => /^create policy/i.test(statement) && / on public\.(?!(?:garages|garage_members|admin_profiles|unmatched_inbound_emails)\b)/.test(statement));
    expect(policies.length).toBeGreaterThan(60);
    for (const policy of policies) expect(policy, policy).toContain("(select public.current_garage_id())");
  });

  it("lists who each table's policies allow in a comment above them", () => {
    for (const table of [...tenantTables.filter((table) => table !== "invoice_number_sequences"), "garages", "garage_domains", "garage_members", "admin_profiles", "unmatched_inbound_emails"]) {
      expect(tenancyMigration, table).toMatch(new RegExp(`\\n-- ${table}(?: \\([^)]*\\))?\\n--   "`));
    }
  });

  it("gives anon nothing", () => {
    expect(tenancyMigration).toContain("revoke all on all tables in schema public from public, anon, authenticated, service_role;");
    expect(tenancyMigration).toContain("revoke all on all functions in schema public from public, anon, authenticated, service_role;");
    expect(tenancyMigration).toContain("alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated, service_role;");
    const grants = tenancyStatements.filter((statement) => /^grant /i.test(statement));
    expect(grants.filter((statement) => /\b(anon|public)\b(?!\.)/.test(statement.replace(/public\.\w+/g, "")))).toEqual([]);
    const policies = tenancyStatements.filter((statement) => /^create policy/i.test(statement));
    expect(policies.filter((statement) => /\bto (anon|public)\b/i.test(statement))).toEqual([]);
  });

  it.each(serviceRoleFunctions)("keeps %s service-role only", (signature) => {
    const grants = tenancyStatements.filter((statement) => statement.startsWith(`grant execute on function public.${signature}`));
    expect(grants).toEqual([`grant execute on function public.${signature} to service_role`]);
  });

  it("removes SOB's single-business authorisation", () => {
    expect(tenancyMigration).toContain("drop function public.is_admin();");
    expect(tenancyMigration).toContain("drop function public.enforce_allowed_admin_email();");
    const afterTenancy = tenancyMigration.replace(/--[^\n]*/g, "").replace("drop function public.is_admin();", "");
    expect(afterTenancy).not.toContain("is_admin(");
    expect(tenancyMigration).not.toMatch(/sobautofix|temitopeagbola/i);
    expect(tenancyMigration).toContain("check (booking_reference ~ '^[A-Z]{2,4}-[0-9]{4,6}$')");
    expect(tenancyMigration).toContain("alter column issuer_legal_name drop default");
  });

  it("defines the garage context helpers from the architecture contract", () => {
    for (const name of ["request_garage_id", "garage_role", "current_garage_id", "current_garage_role", "is_platform_admin"]) {
      const definition = functionDefinition(tenancyMigration, name);
      expect(definition, name).toMatch(/\nstable\nsecurity definer\nset search_path = ''\n/);
      expect(tenancyMigration).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated, service_role;`));
    }
    expect(functionDefinition(tenancyMigration, "request_garage_id")).toContain("current_setting('request.headers', true)");
    expect(functionDefinition(tenancyMigration, "request_garage_id")).toContain("when others then\n    return null;");
  });

  it("keeps uploads inside the garage's storage folder", () => {
    const storagePolicies = tenancyStatements.filter((statement) => /^create policy[^\n]+on storage\.objects/i.test(statement));
    expect(storagePolicies).toHaveLength(5);
    for (const policy of storagePolicies) expect(policy).toContain("(storage.foldername(name))[1] = (select public.current_garage_id())::text");
    expect(tenancyMigration).toContain("check (split_part(object_path, '/', 1) = garage_id::text)");
  });

  it("uses separate public and private buckets", () => {
    expect(baselineMigration).toContain("'public-media'");
    expect(baselineMigration).toContain("('enquiry-attachments', 'enquiry-attachments', false");
  });

  it("limits rate-limit and retention functions to the service role", () => {
    expect(tenancyMigration).toContain("grant execute on function public.consume_rate_limit(text, text, integer, integer) to service_role;");
    expect(tenancyMigration).toContain("grant execute on function public.apply_enquiry_retention(uuid) to service_role;");
  });

  it("keeps booking-created enquiry threads unique per garage and service-role only", () => {
    expect(tenancyMigration).toContain("create unique index enquiries_booking_thread_unique on public.enquiries (garage_id, booking_id)");
    expect(tenancyMigration).toContain("where booking_id is not null");
    expect(functionDefinition(tenancyMigration, "create_booking_enquiry_thread")).toContain("security invoker");
    expect(tenancyMigration).toContain("grant execute on function public.create_booking_enquiry_thread(uuid, uuid, uuid) to service_role;");
  });
});

describe("scheduling migration invariants (P2.1-P2.3)", () => {
  it("follows the tenancy migrations", () => {
    expect(migrationFiles.slice(0, 4)).toEqual([
      "20261026000000_baseline.sql",
      "20261026000100_tenancy.sql",
      "20261026000200_tenancy_test_support.sql",
      "20261027000100_scheduling.sql",
    ]);
    expect(schedulingMigration).toMatch(/^-- Autofix scheduling engine[\s\S]*-- Rollback notes/);
  });

  it("guards bookings with the no_overlap exclusion constraint", () => {
    expect(schedulingMigration).toContain("create extension if not exists btree_gist with schema extensions;");
    expect(schedulingMigration).toContain(
      "constraint no_overlap exclude using gist (resource_id with =, during with &&)\n    where (status not in ('cancelled', 'no_show'))",
    );
    expect(schedulingMigration).toContain("  during tstzrange not null,");
  });

  it.each(schedulingTables)("creates %s as a garage-scoped tenant table with RLS and documented policies", (table) => {
    expect(schedulingMigration).toMatch(new RegExp(
      `create table public\\.${table} \\(\\n  id uuid primary key default gen_random_uuid\\(\\),\\n  garage_id uuid not null default public\\.current_garage_id\\(\\) references public\\.garages\\(id\\) on delete cascade,`,
    ));
    expect(schedulingMigration).toContain(`alter table public.${table} enable row level security;`);
    expect(schedulingMigration, table).toMatch(new RegExp(`\\n-- ${table}\\n--   "`));
    const policies = schedulingStatements.filter((statement) => statement.startsWith("create policy") && statement.includes(` on public.${table}\n`));
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy).toContain("to authenticated");
      expect(policy).toContain("(select public.current_garage_id())");
    }
  });

  it("drops the Cal.com leftovers", () => {
    for (const statement of [
      "drop function public.create_booking_intent(",
      "drop table public.bookings;",
      "drop table public.booking_service_types;",
      "drop table public.service_catalogue_systems;",
      "drop table public.provider_webhook_events;",
      "drop type public.booking_status;",
    ]) expect(schedulingMigration).toContain(statement);
    const createdBookings = schedulingMigration.slice(schedulingMigration.indexOf("create table public.bookings ("));
    expect(createdBookings.slice(0, createdBookings.indexOf("\n);"))).not.toMatch(/provider_|booking_reference|appointment_start|service_type_id/);
  });

  it.each(engineFunctions)("keeps %s service-role only", (signature) => {
    expect(schedulingMigration).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`);
    const grants = schedulingStatements.filter((statement) => statement.startsWith(`grant execute on function public.${signature}`));
    expect(grants).toEqual([`grant execute on function public.${signature} to service_role`]);
  });

  it.each(internalEngineFunctions)("grants %s to no API role", (signature) => {
    expect(schedulingMigration).toContain(`revoke all on function public.${signature} from public, anon, authenticated, service_role;`);
    expect(schedulingStatements.filter((statement) => statement.startsWith(`grant execute on function public.${signature}`))).toEqual([]);
  });

  it("runs the engine as security definer with an empty search_path", () => {
    for (const name of ["available_slots", "available_slots_at", "seed_garage_defaults"]) {
      expect(functionDefinition(schedulingMigration, name), name).toMatch(/\nsecurity definer\nset search_path = ''\n/);
    }
    expect(functionDefinition(schedulingMigration, "available_slots")).toMatch(/\nstable\nsecurity definer\n/);
  });

  it("lets staff change only booking status and notes, never create bookings", () => {
    expect(schedulingMigration).toContain("grant update (status, notes, admin_seen_at, cancellation_reason) on public.bookings to authenticated;");
    const staffBookingGrants = schedulingStatements.filter((statement) => /^grant [^;]* on public\.bookings to authenticated/.test(statement));
    expect(staffBookingGrants.map((statement) => statement.replace(/\s+/g, " "))).toEqual([
      "grant select on public.bookings to authenticated",
      "grant update (status, notes, admin_seen_at, cancellation_reason) on public.bookings to authenticated",
    ]);
  });

  it("gives anon nothing", () => {
    const grants = schedulingStatements.filter((statement) => /^grant /i.test(statement));
    expect(grants.filter((statement) => /\b(anon|public)\b(?!\.)/.test(statement.replace(/public\.\w+/g, "")))).toEqual([]);
    const policies = schedulingStatements.filter((statement) => /^create policy/i.test(statement));
    expect(policies.filter((statement) => /\bto (anon|public)\b/i.test(statement))).toEqual([]);
  });
});
