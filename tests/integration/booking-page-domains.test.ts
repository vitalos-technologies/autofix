import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockDomainsClient, type MockDomainsClient } from "../../src/lib/vercel/domains";
import { getLocalSupabaseConfig, localRunId, provisionLocalTestUsers, type LocalTestUsers } from "../helpers/local-supabase";

// Booking page & domain settings (P4.3) and the Askbridge chat (P4.6) against local
// Supabase: a custom domain connects (RLS insert + service-role records),
// resolves only once active, stays inside its garage, and is retired by its own
// owner only; the owner's settings RPC (Askbridge site key) feeds the proxy's
// CSP inputs; turning the chat on queues nothing (there is no knowledge sync).

const configured = Boolean(process.env.INTEGRATION_SUPABASE_URL);
const SITE_KEY = "pk_0123456789abcdef0123456789abcdef";
const HOST_ENV = { NEXT_PUBLIC_ADMIN_HOST: "autofix.vitalos.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk", DEV_TENANT_ROOT_DOMAIN: "localhost:3000" };
const MINUTE = 60_000;

let users: LocalTestUsers;
let service: SupabaseClient;
let domains: MockDomainsClient;
let hostname: string;
let lib: typeof import("../../src/lib/booking-page/domains-server");
let resolve: typeof import("../../src/lib/tenancy/resolve");

describe.skipIf(!configured).sequential("booking page domains against local Supabase", () => {
  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.BOOKING_MANAGEMENT_SECRET = "integration-booking-management-secret-0123456789";
    users = await provisionLocalTestUsers();
    service = users.service;
    domains = createMockDomainsClient();
    hostname = `book.af${localRunId}motors.co.uk`;
    lib = await import("../../src/lib/booking-page/domains-server");
    resolve = await import("../../src/lib/tenancy/resolve");
  });

  const resolveCustom = (host: string) => resolve.resolveHost(host, { env: HOST_ENV });

  it("connects a custom domain as pending_dns with the records to show", async () => {
    const result = await lib.connectCustomDomain(users.garageA.id, `  ${hostname.toUpperCase()} `, { rls: users.admin, service, domains });
    expect(result).toMatchObject({ ok: true, queued: false, domain: { hostname, status: "pending_dns" } });
    expect(result.ok && result.domain.records).toEqual([{ type: "CNAME", name: "book", host: hostname, value: "cname.vercel-dns-0.com", purpose: "routing" }]);
    expect(domains.list()).toContain(hostname);
    expect(await lib.connectCustomDomain(users.garageA.id, "book.another-af.co.uk", { rls: users.admin, service, domains })).toMatchObject({ ok: false, code: "already_connected" });
  });

  it("refuses the same hostname for another garage", async () => {
    expect(await lib.connectCustomDomain(users.garageB.id, hostname, { rls: users.otherGarageAdmin, service, domains })).toMatchObject({ ok: false, code: "taken" });
    const { data } = await users.otherGarageAdmin.from("garage_domains").select("hostname");
    expect((data ?? []).map((row) => row.hostname)).not.toContain(hostname);
  });

  it("does not serve the host until it is active, then serves garage A", async () => {
    resolve.clearHostCache();
    expect(await resolveCustom(hostname)).toEqual({ kind: "unknown" });

    const start = new Date();
    const first = await lib.checkCustomDomainNow(users.garageA.id, { service, domains, now: start });
    expect(first).toMatchObject({ ok: true, changed: true, domain: { status: "verifying" } });
    expect(await lib.checkCustomDomainNow(users.garageA.id, { service, domains, now: new Date(start.getTime() + MINUTE) })).toMatchObject({ ok: false, code: "throttled" });
    expect(await resolveCustom(hostname)).toEqual({ kind: "unknown" });

    const second = await lib.checkCustomDomainNow(users.garageA.id, { service, domains, now: new Date(start.getTime() + 6 * MINUTE) });
    expect(second).toMatchObject({ ok: true, domain: { status: "active", error: null } });
    // The status write cleared the cached miss, so the host serves at once.
    expect(await resolveCustom(hostname)).toMatchObject({ kind: "garage", via: "custom", garage: { id: users.garageA.id, embedOrigins: [], widgetEnabled: false } });
  });

  it("carries the owner's embed sites and widget setting to the proxy", async () => {
    const saved = await users.admin.rpc("set_booking_page_settings", { p_embed_origins: ["https://www.afmotors.co.uk"], p_askbridge: { enabled: true, siteKey: SITE_KEY } });
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ askbridge: { enabled: true, siteKey: SITE_KEY } });
    // The old widget id shape is refused.
    expect(await users.admin.rpc("set_booking_page_settings", { p_embed_origins: null, p_askbridge: { enabled: true, widgetId: "wid_integration" } })).toMatchObject({ error: { code: "22023" } });
    expect(await users.otherGarageAdminForgingGarageA.rpc("set_booking_page_settings", { p_embed_origins: [], p_askbridge: null })).toMatchObject({ error: { code: "42501" } });
    resolve.clearHostCache({ hostnames: [hostname] });
    expect(await resolveCustom(hostname)).toMatchObject({ kind: "garage", garage: { embedOrigins: ["https://www.afmotors.co.uk"], widgetEnabled: true } });
    expect(await resolve.resolveHost(`${users.garageB.slug}.autofix.vitalos.co.uk`, { env: HOST_ENV })).toMatchObject({ kind: "garage", garage: { id: users.garageB.id, embedOrigins: [], widgetEnabled: false } });
  });

  it("queues nothing for Askbridge: it learns from the garage's website, not from Autofix", async () => {
    const { data: jobs, error } = await service.from("jobs").select("id").eq("kind", "askbridge.sync").in("garage_id", [users.garageA.id, users.garageB.id]);
    expect(error).toBeNull();
    expect(jobs).toEqual([]);
  });

  it("lets only garage A's owner retire the domain; the host stops resolving", async () => {
    expect(await lib.removeCustomDomain(users.garageA.id, { rls: users.otherGarageAdminForgingGarageA, service, domains })).toMatchObject({ ok: false, code: "none" });
    expect(await resolveCustom(hostname)).toMatchObject({ kind: "garage" });

    expect(await lib.removeCustomDomain(users.garageA.id, { rls: users.admin, service, domains })).toEqual({ ok: true, hostname, detached: true });
    expect(await resolveCustom(hostname)).toEqual({ kind: "unknown" });
    expect(domains.list()).not.toContain(hostname);
    expect(await lib.getCustomDomain(service, users.garageA.id)).toBeNull();
  });
});
