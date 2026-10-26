import { describe, expect, it } from "vitest";
import {
  allMigrations,
  baselineMigration,
  functionDefinition,
  migrationFiles,
  sqlStatements,
  tenancyMigration,
} from "./support/migrations";

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
