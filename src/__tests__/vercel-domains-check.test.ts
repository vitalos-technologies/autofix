import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DomainsError,
  createMockDomainsClient,
  getDomainsClient,
  isDomainsError,
  type DomainConfig,
  type DomainsClient,
  type MockDomainsClient,
  type ProjectDomain,
} from "@/lib/vercel/domains";
import {
  DOMAIN_CHECK_INTERVAL_MS,
  DOMAIN_CHECK_WINDOW_MS,
  nextDomainStatus,
  removeDomainConnection,
  runDomainsCheck,
  startDomainConnection,
  type DomainStatusPatch,
  type DomainToCheck,
  type DomainsCheckRepo,
} from "@/lib/vercel/domains-check";

const T0 = new Date("2026-10-26T09:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

type StoredRow = DomainToCheck & { error: string | null };

/** In-memory stand-in for the Supabase-backed repo P3.7 will provide. */
function memoryRepo(rows: DomainToCheck[], options: { filter?: boolean } = {}) {
  const store = new Map<string, StoredRow>(rows.map((row) => [row.id, { ...row, error: null }]));
  const updates: Array<{ id: string; patch: DomainStatusPatch }> = [];
  const repo: DomainsCheckRepo = {
    async listDomainsToCheck() {
      const all = [...store.values()].map((row) => ({ ...row }));
      return options.filter === false ? all : all.filter((row) => row.status === "pending_dns" || row.status === "verifying");
    },
    async updateDomainStatus(id, patch) {
      updates.push({ id, patch });
      const row = store.get(id);
      if (!row) throw new Error(`unknown row ${id}`);
      row.status = patch.status;
      row.error = patch.error;
      row.lastCheckedAt = patch.lastCheckedAt;
    },
  };
  return { repo, store, updates, row: (id: string) => store.get(id) };
}

function domainRow(id: string, hostname: string, overrides: Partial<DomainToCheck> = {}): DomainToCheck {
  return { id, hostname, garageId: `garage-${id}`, kind: "custom", status: "pending_dns", pendingSince: T0, lastCheckedAt: null, ...overrides };
}

const CONFIGURED: DomainConfig = { misconfigured: false, configuredBy: "CNAME", recommendedCname: "cname.vercel-dns-0.com", recommendedIPv4: [], acceptedChallenges: ["http-01"] };
const NO_DNS: DomainConfig = { misconfigured: true, configuredBy: null, recommendedCname: "cname.vercel-dns-0.com", recommendedIPv4: [], acceptedChallenges: [] };

/** Scriptable client: per-host overrides on top of a fully configured, verified domain. */
function scriptedClient(overrides: Record<string, Partial<{ getDomain: () => Promise<ProjectDomain>; getConfig: () => Promise<DomainConfig> }>> = {}) {
  const domain = (name: string): ProjectDomain => ({ name, apexName: name.split(".").slice(1).join("."), projectId: "prj", verified: true, verification: [] });
  const client: DomainsClient = {
    mode: "mock",
    addDomain: vi.fn(async (name: string) => ({ ...domain(name), alreadyExisted: false })),
    getDomain: vi.fn(async (name: string) => (overrides[name]?.getDomain ? overrides[name].getDomain() : domain(name))),
    getConfig: vi.fn(async (name: string) => (overrides[name]?.getConfig ? overrides[name].getConfig() : CONFIGURED)),
    verifyDomain: vi.fn(async (name: string) => ({ name, verified: true, reason: null })),
    removeDomain: vi.fn(async () => ({ removed: true })),
  };
  return client;
}

describe("domains.check status machine", () => {
  it("moves pending_dns -> verifying -> active, checking each row at most every 5 minutes", async () => {
    const client = createMockDomainsClient();
    await startDomainConnection("book.hartleyroad.co.uk", { client });
    const { repo, row, updates } = memoryRepo([domainRow("d1", "book.hartleyroad.co.uk")]);

    const first = await runDomainsCheck({ repo, client, now: T0 });
    expect(first).toMatchObject({ considered: 1, checked: 1, skipped: 0, stopped: null, errors: [] });
    expect(first.outcomes).toEqual([{ id: "d1", hostname: "book.hartleyroad.co.uk", garageId: "garage-d1", from: "pending_dns", to: "verifying", error: null }]);
    expect(row("d1")).toMatchObject({ status: "verifying", error: null, lastCheckedAt: T0 });

    const getDomain = vi.spyOn(client, "getDomain");
    const tooSoon = await runDomainsCheck({ repo, client, now: at(DOMAIN_CHECK_INTERVAL_MS - 1) });
    expect(tooSoon).toMatchObject({ considered: 1, checked: 0, skipped: 1 });
    expect(getDomain).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);

    const second = await runDomainsCheck({ repo, client, now: at(DOMAIN_CHECK_INTERVAL_MS) });
    expect(second.outcomes[0]).toMatchObject({ from: "verifying", to: "active", error: null });
    expect(row("d1")).toMatchObject({ status: "active", error: null });

    const afterActive = await runDomainsCheck({ repo, client, now: at(HOUR) });
    expect(afterActive.considered).toBe(0);
  });

  it("keeps a domain without DNS in pending_dns until 48 hours, then fails with the CNAME reason", async () => {
    const client = createMockDomainsClient();
    await client.addDomain("book.failgarage.co.uk");
    const { repo, row } = memoryRepo([domainRow("d1", "book.failgarage.co.uk")]);

    await runDomainsCheck({ repo, client, now: T0 });
    expect(row("d1")?.status).toBe("pending_dns");
    await runDomainsCheck({ repo, client, now: at(DOMAIN_CHECK_WINDOW_MS - DOMAIN_CHECK_INTERVAL_MS) });
    expect(row("d1")).toMatchObject({ status: "pending_dns", error: null });

    const result = await runDomainsCheck({ repo, client, now: at(DOMAIN_CHECK_WINDOW_MS) });
    expect(result.outcomes[0]).toMatchObject({ from: "pending_dns", to: "failed" });
    expect(row("d1")?.status).toBe("failed");
    expect(row("d1")?.error).toContain("CNAME record for book.failgarage.co.uk pointing to cname.vercel-dns-0.com");
  });

  it("fails an unverified domain after 48 hours with the TXT ownership reason", async () => {
    const client = createMockDomainsClient();
    await client.addDomain("book.pendinggarage.co.uk");
    const { repo, row } = memoryRepo([domainRow("d1", "book.pendinggarage.co.uk", { pendingSince: at(-DOMAIN_CHECK_WINDOW_MS - HOUR) })]);
    await runDomainsCheck({ repo, client, now: T0 });
    expect(row("d1")?.status).toBe("failed");
    expect(row("d1")?.error).toContain("TXT record _vercel.pendinggarage.co.uk");
  });

  it("fails a domain that points at us but never gets HTTPS with the certificate reason", async () => {
    const client = scriptedClient({ "book.proxied.co.uk": { getConfig: async () => ({ ...NO_DNS, configuredBy: "http" }) } });
    const { repo, row } = memoryRepo([domainRow("d1", "book.proxied.co.uk", { status: "verifying", pendingSince: at(-DOMAIN_CHECK_WINDOW_MS) })]);
    await runDomainsCheck({ repo, client, now: T0 });
    expect(row("d1")?.status).toBe("failed");
    expect(row("d1")?.error).toContain("couldn't secure it with HTTPS");
  });

  it("checks before applying the 48-hour cut-off, so a domain fixed at the last minute goes live", async () => {
    const client = createMockDomainsClient();
    await client.addDomain("book.latefix.co.uk");
    const { repo, row } = memoryRepo([domainRow("d1", "book.latefix.co.uk", { lastCheckedAt: at(47 * HOUR - 10 * MINUTE) })]);
    await runDomainsCheck({ repo, client, now: at(47 * HOUR) });
    expect(row("d1")?.status).toBe("verifying");
    await runDomainsCheck({ repo, client, now: at(DOMAIN_CHECK_WINDOW_MS + MINUTE) });
    expect(row("d1")).toMatchObject({ status: "active", error: null });
  });

  it("re-asks Vercel to verify the TXT challenge while a domain is unverified", async () => {
    const client = createMockDomainsClient();
    await client.addDomain("book.pendinggarage.co.uk");
    const verify = vi.spyOn(client, "verifyDomain");
    const { repo } = memoryRepo([domainRow("d1", "book.pendinggarage.co.uk")]);
    await runDomainsCheck({ repo, client, now: T0 });
    expect(verify).toHaveBeenCalledWith("book.pendinggarage.co.uk");
  });

  it("re-adds a domain that is missing from the Vercel project (queued or rate-limited add)", async () => {
    const client = createMockDomainsClient();
    const { repo, row } = memoryRepo([domainRow("d1", "book.queued.co.uk")]);
    await runDomainsCheck({ repo, client, now: T0 });
    expect(client.list()).toEqual(["book.queued.co.uk"]);
    expect(row("d1")?.status).toBe("verifying");
  });

  it("fails straight away when the domain is taken by another project", async () => {
    const client = createMockDomainsClient();
    const { repo, row } = memoryRepo([domainRow("d1", "book.takengarage.co.uk")]);
    await runDomainsCheck({ repo, client, now: T0 });
    expect(row("d1")?.status).toBe("failed");
    expect(row("d1")?.error).toContain("already connected to another website");
  });

  it("fails rows with a hostname we would never connect without calling Vercel", async () => {
    const client = scriptedClient();
    const { repo, row } = memoryRepo([domainRow("d1", "hartley-road.pitline.co.uk"), domainRow("d2", "theirgarage.co.uk")]);
    await runDomainsCheck({ repo, client, now: T0 });
    expect(row("d1")?.status).toBe("failed");
    expect(row("d2")?.status).toBe("failed");
    expect(row("d2")?.error).toContain("book.theirgarage.co.uk");
    expect(client.getDomain).not.toHaveBeenCalled();
  });

  it("skips active, failed and free-subdomain rows even if the repo returns them", async () => {
    const client = scriptedClient();
    const { repo, updates } = memoryRepo([
      domainRow("a", "book.active.co.uk", { status: "active" }),
      domainRow("f", "book.failed.co.uk", { status: "failed" }),
      domainRow("s", "hartley-road.pitline.co.uk", { kind: "subdomain" }),
      domainRow("p", "book.pending.co.uk"),
    ], { filter: false });
    const result = await runDomainsCheck({ repo, client, now: T0 });
    expect(result).toMatchObject({ considered: 4, checked: 1, skipped: 3 });
    expect(updates.map((update) => update.id)).toEqual(["p"]);
  });

  it("processes the longest-unchecked rows first, up to the batch size", async () => {
    const client = scriptedClient();
    const { repo, updates } = memoryRepo([
      domainRow("recent", "book.recent.co.uk", { lastCheckedAt: at(-10 * MINUTE) }),
      domainRow("never", "book.never.co.uk", { lastCheckedAt: null }),
      domainRow("older", "book.older.co.uk", { lastCheckedAt: at(-20 * MINUTE).toISOString() }),
    ]);
    const result = await runDomainsCheck({ repo, client, now: T0, batchSize: 2 });
    expect(updates.map((update) => update.id)).toEqual(["never", "older"]);
    expect(result).toMatchObject({ checked: 2, skipped: 1 });
  });

  it("stops the batch on rate_limited and leaves the remaining rows untouched", async () => {
    const client = scriptedClient({
      "book.b.co.uk": { getDomain: async () => { throw new DomainsError("rate_limited", "slow down", { status: 429, retryAfterMs: 90_000 }); } },
    });
    const { repo, updates } = memoryRepo([
      domainRow("a", "book.a.co.uk"),
      domainRow("b", "book.b.co.uk", { lastCheckedAt: at(-HOUR) }),
      domainRow("c", "book.c.co.uk", { lastCheckedAt: at(-30 * MINUTE) }),
    ]);
    const result = await runDomainsCheck({ repo, client, now: T0 });
    expect(result.stopped).toEqual({ reason: "rate_limited", retryAfterMs: 90_000 });
    expect(result).toMatchObject({ checked: 1, skipped: 2 });
    expect(updates.map((update) => update.id)).toEqual(["a"]);
    expect(client.getDomain).not.toHaveBeenCalledWith("book.c.co.uk");
  });

  it("stops without updates when the integration is not configured", async () => {
    const client = scriptedClient({
      "book.a.co.uk": { getDomain: async () => { throw new DomainsError("configuration_required", "Vercel rejected the API token. Check VERCEL_API_TOKEN."); } },
    });
    const { repo, updates } = memoryRepo([domainRow("a", "book.a.co.uk"), domainRow("b", "book.b.co.uk", { lastCheckedAt: at(-HOUR) })]);
    const result = await runDomainsCheck({ repo, client, now: T0 });
    expect(result.stopped).toEqual({ reason: "configuration_required", message: "Vercel rejected the API token. Check VERCEL_API_TOKEN." });
    expect(updates).toEqual([]);
  });

  it("records a transient error, backs that row off 5 minutes and carries on", async () => {
    const client = scriptedClient({
      "book.a.co.uk": { getConfig: async () => { throw new DomainsError("upstream_error", "Vercel returned 503", { status: 503 }); } },
    });
    const { repo, row } = memoryRepo([domainRow("a", "book.a.co.uk", { status: "verifying" }), domainRow("b", "book.b.co.uk", { lastCheckedAt: at(-HOUR) })]);
    const result = await runDomainsCheck({ repo, client, now: T0 });
    expect(result.errors).toEqual([{ id: "a", hostname: "book.a.co.uk", garageId: "garage-a", code: "upstream_error", message: "Vercel returned 503" }]);
    expect(row("a")).toMatchObject({ status: "verifying", error: null, lastCheckedAt: T0 });
    expect(row("b")?.status).toBe("active");
    expect(result).toMatchObject({ checked: 1, stopped: null });
  });

  it.each([
    [true, CONFIGURED, "active"],
    [true, { ...CONFIGURED, misconfigured: true }, "verifying"],
    [false, CONFIGURED, "verifying"],
    [true, NO_DNS, "pending_dns"],
    [false, NO_DNS, "pending_dns"],
    [true, { ...NO_DNS, configuredBy: "A" }, "verifying"],
  ] as const)("verified=%s with config %j is %s", (verified, config, expected) => {
    expect(nextDomainStatus({ verified, config })).toBe(expected);
  });
});

describe("startDomainConnection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    (getDomainsClient({}) as MockDomainsClient).reset();
  });

  it("adds the domain and returns the CNAME to show", async () => {
    const client = createMockDomainsClient();
    await expect(startDomainConnection(" Book.HartleyRoad.co.uk ", { client })).resolves.toEqual({
      hostname: "book.hartleyroad.co.uk",
      apexName: "hartleyroad.co.uk",
      status: "pending_dns",
      verified: true,
      alreadyExisted: false,
      records: [{ type: "CNAME", name: "book", host: "book.hartleyroad.co.uk", value: "cname.vercel-dns-0.com", purpose: "routing" }],
    });
    await expect(startDomainConnection("book.hartleyroad.co.uk", { client })).resolves.toMatchObject({ alreadyExisted: true });
  });

  it("uses VERCEL_DOMAIN_CNAME_TARGET and the full subdomain for deeper names", async () => {
    vi.stubEnv("VERCEL_DOMAIN_CNAME_TARGET", "abc.vercel-dns-017.com");
    const result = await startDomainConnection("bookings.shop.garage.co.uk", { client: createMockDomainsClient() });
    expect(result.records[0]).toEqual({ type: "CNAME", name: "bookings.shop", host: "bookings.shop.garage.co.uk", value: "abc.vercel-dns-017.com", purpose: "routing" });
  });

  it("includes the TXT ownership record when Vercel asks for one", async () => {
    const result = await startDomainConnection("book.pendinggarage.co.uk", { client: createMockDomainsClient() });
    expect(result.verified).toBe(false);
    expect(result.records).toHaveLength(2);
    expect(result.records[1]).toMatchObject({ type: "TXT", name: "_vercel", host: "_vercel.pendinggarage.co.uk", purpose: "ownership" });
    expect(result.records[1]?.value).toMatch(/^vc-domain-verify=/);
  });

  it.each(["https://book.hartleyroad.co.uk", "hartleyroad.co.uk", "hartley-road.pitline.co.uk", "localhost"])(
    "rejects %s with invalid_domain before calling Vercel",
    async (input) => {
      const client = scriptedClient();
      const error = await startDomainConnection(input, { client }).catch((caught: unknown) => caught);
      expect(isDomainsError(error) && error.code).toBe("invalid_domain");
      expect((error as Error).message.length).toBeGreaterThan(10);
      expect(client.addDomain).not.toHaveBeenCalled();
    },
  );

  it("passes on domain_taken and rate_limited from Vercel", async () => {
    const client = createMockDomainsClient();
    await expect(startDomainConnection("book.takengarage.co.uk", { client })).rejects.toMatchObject({ code: "domain_taken" });
    await expect(startDomainConnection("book.ratelimitgarage.co.uk", { client })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 60_000 });
  });

  it("uses the configured client (the shared mock in dev and tests) by default", async () => {
    const result = await startDomainConnection("book.sharedmock.co.uk");
    expect(result.status).toBe("pending_dns");
    expect((getDomainsClient({}) as MockDomainsClient).list()).toContain("book.sharedmock.co.uk");
  });
});

describe("removeDomainConnection", () => {
  it("removes the domain and is idempotent", async () => {
    const client = createMockDomainsClient();
    await client.addDomain("book.hartleyroad.co.uk");
    await expect(removeDomainConnection("Book.HartleyRoad.co.uk", { client })).resolves.toEqual({ hostname: "book.hartleyroad.co.uk", removed: true });
    await expect(removeDomainConnection("book.hartleyroad.co.uk", { client })).resolves.toEqual({ hostname: "book.hartleyroad.co.uk", removed: false });
  });

  it.each(["pitline.co.uk", "hartley-road.pitline.co.uk", ""])("refuses to remove %j", async (input) => {
    const client = scriptedClient();
    await expect(removeDomainConnection(input, { client })).rejects.toMatchObject({ code: "invalid_domain" });
    expect(client.removeDomain).not.toHaveBeenCalled();
  });
});
