import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CNAME_TARGET,
  DomainsError,
  createMockDomainsClient,
  createVercelDomainsClient,
  getDomainCnameTarget,
  getDomainsClient,
  getDomainsReadiness,
  isDomainsError,
  type DomainsClient,
  type MockDomainsClient,
} from "@/lib/vercel/domains";
import { isPlatformHostname, registrableDomain, validateGarageHostname } from "@/lib/vercel/hostname";

const TOKEN = "tok_test_never_print_me";
const PROJECT = "prj_123";
const TEAM = "team_456";
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const HOST = "book.theirgarage.co.uk";

type Reply = Response | Error | ((init: RequestInit) => Promise<Response>);
type Call = { url: URL; init: RequestInit };

function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function vercelError(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json(status, { error: { code, message, ...extra } }, headers);
}

function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = replies.shift();
    if (!next) throw new Error("Unexpected extra fetch");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(init ?? {}) : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

function liveClient(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createVercelDomainsClient>[0]> = {}): DomainsClient {
  return createVercelDomainsClient({ token: TOKEN, projectId: PROJECT, teamId: TEAM, fetch: fetchImpl, retryBaseDelayMs: 0, now: () => NOW, ...extra });
}

const projectDomain = (overrides: Record<string, unknown> = {}) => ({
  name: HOST,
  apexName: "theirgarage.co.uk",
  projectId: PROJECT,
  verified: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

async function caught(promise: Promise<unknown>): Promise<DomainsError> {
  try {
    await promise;
  } catch (error) {
    if (isDomainsError(error)) return error;
    throw error;
  }
  throw new Error("Expected a DomainsError");
}

function header(call: Call | undefined, name: string): string | undefined {
  return (call?.init.headers as Record<string, string> | undefined)?.[name];
}

describe("hostname validation", () => {
  it.each([
    ["book.theirgarage.co.uk", "book.theirgarage.co.uk", "theirgarage.co.uk", "book"],
    ["  BOOK.TheirGarage.CO.UK. ", "book.theirgarage.co.uk", "theirgarage.co.uk", "book"],
    ["www.garage.com", "www.garage.com", "garage.com", "www"],
    ["bookings.shop.garage.org.uk", "bookings.shop.garage.org.uk", "garage.org.uk", "bookings.shop"],
    ["book.my-garage2.uk", "book.my-garage2.uk", "my-garage2.uk", "book"],
    ["book.bücher.de", "book.xn--bcher-kva.de", "xn--bcher-kva.de", "book"],
  ])("accepts %s", (input, hostname, apexName, subdomain) => {
    expect(validateGarageHostname(input)).toEqual({ ok: true, hostname, apexName, subdomain });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["https://book.theirgarage.co.uk", "has_scheme"],
    ["//book.theirgarage.co.uk", "has_scheme"],
    ["book.theirgarage.co.uk/book", "has_path"],
    ["book.theirgarage.co.uk?x=1", "has_path"],
    ["book.theirgarage.co.uk:443", "has_port"],
    ["*.theirgarage.co.uk", "wildcard"],
    ["book_online.theirgarage.co.uk", "invalid_characters"],
    ["-book.theirgarage.co.uk", "invalid_characters"],
    ["book..theirgarage.co.uk", "invalid_characters"],
    ["me@theirgarage.co.uk", "invalid_characters"],
    [`${"a".repeat(64)}.theirgarage.co.uk`, "too_long"],
    [`${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.co.uk`, "too_long"],
    ["192.168.0.1", "ip_address"],
    ["[::1]", "ip_address"],
    ["::1", "ip_address"],
    ["localhost", "localhost"],
    ["hartley-road.localhost", "localhost"],
    ["book.garage.test", "reserved_tld"],
    ["book.garage.local", "reserved_tld"],
    ["book.garage.c0m", "invalid_characters"],
    ["pitline.co.uk", "platform_domain"],
    ["hartley-road.pitline.co.uk", "platform_domain"],
    ["vitalos.co.uk", "platform_domain"],
    ["book.vitalos.co.uk", "platform_domain"],
    ["mygarage.vercel.app", "not_owned"],
    ["mygarage.github.io", "not_owned"],
    ["theirgarage.co.uk", "not_subdomain"],
    ["garage.com", "not_subdomain"],
    ["co.uk", "not_subdomain"],
    ["garage", "not_subdomain"],
  ])("rejects %j as %s", (input, reason) => {
    const result = validateGarageHostname(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.message.length).toBeGreaterThan(10);
    }
  });

  it("suggests a subdomain of the garage's own domain for an apex", () => {
    const result = validateGarageHostname("theirgarage.co.uk");
    expect(!result.ok && result.message).toContain("book.theirgarage.co.uk");
  });

  it("treats the configured tenant root as a platform domain", () => {
    vi.stubEnv("NEXT_PUBLIC_TENANT_ROOT_DOMAIN", "garages.example-platform.net:3000");
    try {
      expect(validateGarageHostname("demo.garages.example-platform.net")).toMatchObject({ ok: false, reason: "platform_domain" });
      expect(isPlatformHostname("pitline.co.uk")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["book.theirgarage.co.uk", "theirgarage.co.uk"],
    ["a.b.garage.org.uk", "garage.org.uk"],
    ["www.garage.com", "garage.com"],
    ["garage.com", "garage.com"],
    ["co.uk", null],
    ["uk", null],
  ])("registrable domain of %s is %s", (input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });
});

describe("Vercel domains client: request shape", () => {
  it("adds a domain with POST /v10, teamId, bearer auth and a JSON body", async () => {
    const { fetch, calls } = fakeFetch(json(200, projectDomain({
      verified: false,
      verification: [{ type: "TXT", domain: "_vercel.theirgarage.co.uk", value: "vc-domain-verify=book.theirgarage.co.uk,abc", reason: "pending_domain_verification" }],
    })));
    const result = await liveClient(fetch).addDomain("Book.TheirGarage.co.uk");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.init.method).toBe("POST");
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe("https://api.vercel.com/v10/projects/prj_123/domains");
    expect(call?.url.searchParams.get("teamId")).toBe(TEAM);
    expect(header(call, "Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(call, "Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({ name: HOST });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      name: HOST,
      apexName: "theirgarage.co.uk",
      projectId: PROJECT,
      verified: false,
      alreadyExisted: false,
      verification: [{ type: "TXT", domain: "_vercel.theirgarage.co.uk", value: "vc-domain-verify=book.theirgarage.co.uk,abc", reason: "pending_domain_verification" }],
    });
  });

  it("gets a project domain with GET /v9", async () => {
    const { fetch, calls } = fakeFetch(json(200, projectDomain()));
    const result = await liveClient(fetch).getDomain(HOST);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe(`/v9/projects/prj_123/domains/${HOST}`);
    expect(calls[0]?.url.searchParams.get("teamId")).toBe(TEAM);
    expect(header(calls[0], "Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(calls[0], "Content-Type")).toBeUndefined();
    expect(result).toMatchObject({ name: HOST, verified: true, verification: [] });
  });

  it("verifies with POST /v9/.../verify", async () => {
    const { fetch, calls } = fakeFetch(json(200, projectDomain({ verified: true })));
    await expect(liveClient(fetch).verifyDomain(HOST)).resolves.toEqual({ name: HOST, verified: true, reason: null });
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(`/v9/projects/prj_123/domains/${HOST}/verify`);
    expect(calls[0]?.url.searchParams.get("teamId")).toBe(TEAM);
  });

  it("removes with DELETE /v9", async () => {
    const { fetch, calls } = fakeFetch(json(200, {}));
    await expect(liveClient(fetch).removeDomain(HOST)).resolves.toEqual({ removed: true });
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe(`/v9/projects/prj_123/domains/${HOST}`);
    expect(calls[0]?.url.searchParams.get("teamId")).toBe(TEAM);
  });

  it("reads config with GET /v6/domains/{domain}/config scoped to the team and project", async () => {
    const { fetch, calls } = fakeFetch(json(200, {
      configuredBy: "CNAME",
      misconfigured: false,
      acceptedChallenges: ["http-01"],
      recommendedCNAME: [{ rank: 2, value: "abc.vercel-dns-017.com." }, { rank: 1, value: "cname.vercel-dns-0.com." }],
      recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }],
    }));
    const config = await liveClient(fetch).getConfig(HOST);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe(`/v6/domains/${HOST}/config`);
    expect(calls[0]?.url.searchParams.get("teamId")).toBe(TEAM);
    expect(calls[0]?.url.searchParams.get("projectIdOrName")).toBe(PROJECT);
    expect(config).toEqual({
      misconfigured: false,
      configuredBy: "CNAME",
      recommendedCname: "cname.vercel-dns-0.com",
      recommendedIPv4: ["76.76.21.21"],
      acceptedChallenges: ["http-01"],
    });
  });

  it("maps a config with no DNS yet", async () => {
    const { fetch } = fakeFetch(json(200, { configuredBy: null, misconfigured: true, acceptedChallenges: [], recommendedCNAME: [], recommendedIPv4: [] }));
    await expect(liveClient(fetch).getConfig(HOST)).resolves.toMatchObject({ misconfigured: true, configuredBy: null, recommendedCname: null });
  });

  it("omits teamId when none is configured", async () => {
    const { fetch, calls } = fakeFetch(json(200, projectDomain()));
    await liveClient(fetch, { teamId: undefined }).getDomain(HOST);
    expect(calls[0]?.url.searchParams.has("teamId")).toBe(false);
  });

  it("rejects unsafe hostnames before any request", async () => {
    const { fetch, fn } = fakeFetch();
    const client = liveClient(fetch);
    for (const bad of ["", "../../v2/user", "book.theirgarage.co.uk/../../x", "a..b.co.uk", "book theirgarage.co.uk"]) {
      expect((await caught(client.getDomain(bad))).code).toBe("invalid_domain");
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses to add or remove platform domains", async () => {
    const { fetch, fn } = fakeFetch();
    const client = liveClient(fetch);
    expect((await caught(client.removeDomain("pitline.co.uk"))).code).toBe("invalid_domain");
    expect((await caught(client.addDomain("hartley-road.pitline.co.uk"))).code).toBe("invalid_domain");
    expect(fn).not.toHaveBeenCalled();
  });

  it("needs a token and project ID", () => {
    expect(() => createVercelDomainsClient({ token: "", projectId: PROJECT })).toThrowError(DomainsError);
    expect(() => createVercelDomainsClient({ token: TOKEN, projectId: " " })).toThrowError(/VERCEL_PROJECT_ID/);
  });
});

describe("Vercel domains client: idempotency", () => {
  it("treats a 400 'already exists on this project' as success", async () => {
    const { fetch, calls } = fakeFetch(
      vercelError(400, "domain_already_exists", "The domain book.theirgarage.co.uk already exists on this project"),
      json(200, projectDomain()),
    );
    await expect(liveClient(fetch).addDomain(HOST)).resolves.toMatchObject({ name: HOST, verified: true, alreadyExisted: true });
    expect(calls.map((call) => call.init.method)).toEqual(["POST", "GET"]);
  });

  it("treats a 409 for a domain that is on our project as success", async () => {
    const { fetch } = fakeFetch(vercelError(409, "domain_already_in_use", "Domain is used by another project"), json(200, projectDomain()));
    await expect(liveClient(fetch).addDomain(HOST)).resolves.toMatchObject({ alreadyExisted: true });
  });

  it("maps a 409 for a domain on another project to domain_taken", async () => {
    const { fetch } = fakeFetch(
      vercelError(409, "domain_already_in_use", "The domain is already assigned to another Vercel project"),
      vercelError(404, "not_found", "Project domain not found"),
    );
    const error = await caught(liveClient(fetch).addDomain(HOST));
    expect(error).toMatchObject({ code: "domain_taken", status: 409, vercelCode: "domain_already_in_use", retryable: false });
  });

  it("removing a domain that is not there is success", async () => {
    const { fetch } = fakeFetch(vercelError(404, "not_found", "Project domain not found"));
    await expect(liveClient(fetch).removeDomain(HOST)).resolves.toEqual({ removed: false });
  });

  it("returns verified: false (not an error) while the TXT record is missing", async () => {
    const { fetch } = fakeFetch(vercelError(400, "missing_txt_record", "The domain does not have a TXT record that attempts to verify the project domain"));
    await expect(liveClient(fetch).verifyDomain(HOST)).resolves.toEqual({
      name: HOST,
      verified: false,
      reason: "The domain does not have a TXT record that attempts to verify the project domain",
    });
  });

  it("maps verify on a domain not on the project to not_found", async () => {
    const { fetch } = fakeFetch(vercelError(400, "bad_request", "Project domain is not assigned to project"));
    expect((await caught(liveClient(fetch).verifyDomain(HOST))).code).toBe("not_found");
  });
});

describe("Vercel domains client: error mapping", () => {
  it.each([
    ["add", 400, "invalid_domain", "Invalid domain or TLD", "invalid_domain"],
    ["add", 400, "bad_request", "The domain is not valid", "invalid_domain"],
    ["add", 401, "forbidden", "Not authorized", "configuration_required"],
    ["add", 402, "payment_required", "The account is missing a payment", "forbidden"],
    ["add", 403, "forbidden", "Not authorized", "forbidden"],
    ["add", 403, "forbidden", "You don't have access to the domain you are adding", "domain_taken"],
    ["add", 404, "not_found", "Project not found", "configuration_required"],
    ["get", 404, "not_found", "Project domain not found", "not_found"],
    ["get", 403, "forbidden", "You do not have permission to access this resource.", "forbidden"],
    ["get", 410, "gone", "Gone", "upstream_error"],
    ["config", 400, "bad_request", "One of the provided values in the request query is invalid.", "upstream_error"],
    ["remove", 409, "conflict", "The project is currently being transferred", "upstream_error"],
  ] as const)("%s %i %s maps to %s", async (operation, status, vercelCode, message, expected) => {
    // A second reply covers the idempotency probe that follows some add failures.
    const { fetch } = fakeFetch(vercelError(status, vercelCode, message), vercelError(404, "not_found", "Project domain not found"));
    const client = liveClient(fetch);
    const call = operation === "add" ? client.addDomain(HOST)
      : operation === "get" ? client.getDomain(HOST)
        : operation === "config" ? client.getConfig(HOST)
          : client.removeDomain(HOST);
    const error = await caught(call);
    expect(error.code).toBe(expected);
    expect(error.status).toBe(status);
    expect(error.vercelCode).toBe(vercelCode);
  });

  it("maps 429 to rate_limited using Retry-After and does not retry", async () => {
    const { fetch, fn } = fakeFetch(vercelError(429, "rate_limited", "Rate limit exceeded", {}, { "retry-after": "30" }));
    const error = await caught(liveClient(fetch).addDomain(HOST));
    expect(error).toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: 30_000, retryable: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses the error body's limit.resetMs when there is no Retry-After", async () => {
    const { fetch } = fakeFetch(vercelError(429, "rate_limited", "The rate limit of 100 exceeded", { limit: { remaining: 0, reset: (NOW + 45_000) / 1000, resetMs: NOW + 45_000, total: 100 } }));
    expect((await caught(liveClient(fetch).getConfig(HOST))).retryAfterMs).toBe(45_000);
  });

  it("falls back to X-RateLimit-Reset (epoch seconds), then to 60 seconds", async () => {
    const first = fakeFetch(json(429, { error: { code: "rate_limit_exceeded", message: "Too many requests" } }, { "x-ratelimit-reset": String(NOW / 1000 + 120) }));
    expect((await caught(liveClient(first.fetch).getDomain(HOST))).retryAfterMs).toBe(120_000);
    const second = fakeFetch(json(429, null));
    expect((await caught(liveClient(second.fetch).getDomain(HOST))).retryAfterMs).toBe(60_000);
  });

  it("retries 5xx with backoff and then reports upstream_error", async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetch, fn } = fakeFetch(json(500, null), json(502, null), vercelError(503, "internal_server_error", "Unavailable"));
    const error = await caught(liveClient(fetch, { sleep, retryBaseDelayMs: 100 }).getDomain(HOST));
    expect(error).toMatchObject({ code: "upstream_error", status: 503, retryable: true });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const delays = sleep.mock.calls.map((args: unknown[]) => Number(args[0]));
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });

  it("succeeds when a retry succeeds", async () => {
    const { fetch, fn } = fakeFetch(json(503, null), json(200, projectDomain()));
    await expect(liveClient(fetch).getDomain(HOST)).resolves.toMatchObject({ verified: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("maps network failures to upstream_error after retries", async () => {
    const { fetch, fn } = fakeFetch(new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed"));
    const error = await caught(liveClient(fetch).getConfig(HOST));
    expect(error).toMatchObject({ code: "upstream_error", status: null, message: "Could not reach Vercel." });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("times out slow requests with an AbortSignal", async () => {
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const { fetch } = fakeFetch(hang);
    const error = await caught(liveClient(fetch, { timeoutMs: 5, retries: 0 }).getDomain(HOST));
    expect(error).toMatchObject({ code: "upstream_error", message: "Vercel did not respond in time." });
  });

  it("maps an unexpected response shape to upstream_error", async () => {
    const { fetch } = fakeFetch(json(200, { surprise: true }));
    expect((await caught(liveClient(fetch).getDomain(HOST))).code).toBe("upstream_error");
  });

  it("never exposes the token on the client or in errors", async () => {
    const { fetch } = fakeFetch(vercelError(403, "forbidden", "Not authorized"));
    const client = liveClient(fetch);
    const error = await caught(client.getDomain(HOST));
    for (const text of [JSON.stringify(client), JSON.stringify(error), String(error), error.message, JSON.stringify(Object.values(client))]) {
      expect(text).not.toContain(TOKEN);
    }
  });
});

describe("mock domains client", () => {
  it("verifies ordinary domains on add and goes live on the second config check", async () => {
    const client = createMockDomainsClient();
    expect(client.mode).toBe("mock");
    await expect(client.addDomain(HOST)).resolves.toMatchObject({ name: HOST, apexName: "theirgarage.co.uk", verified: true, verification: [], alreadyExisted: false });
    await expect(client.getConfig(HOST)).resolves.toMatchObject({ misconfigured: true, configuredBy: "CNAME", recommendedCname: DEFAULT_CNAME_TARGET });
    await expect(client.getConfig(HOST)).resolves.toMatchObject({ misconfigured: false, configuredBy: "CNAME" });
    await expect(client.getConfig(HOST)).resolves.toMatchObject({ misconfigured: false });
  });

  it("keeps `pending` domains unverified with a deterministic TXT challenge", async () => {
    const host = "book.pendinggarage.co.uk";
    const first = await createMockDomainsClient().addDomain(host);
    const second = await createMockDomainsClient().addDomain(host);
    expect(first.verified).toBe(false);
    expect(first.verification).toEqual(second.verification);
    expect(first.verification[0]).toMatchObject({ type: "TXT", domain: "_vercel.pendinggarage.co.uk" });
    expect(first.verification[0]?.value).toMatch(/^vc-domain-verify=book\.pendinggarage\.co\.uk,[0-9a-f]{8}$/);

    const client = createMockDomainsClient();
    await client.addDomain(host);
    await expect(client.verifyDomain(host)).resolves.toMatchObject({ verified: false });
    await expect(client.getConfig(host)).resolves.toMatchObject({ misconfigured: true, configuredBy: null });
    await expect(client.getConfig(host)).resolves.toMatchObject({ misconfigured: true, configuredBy: null });
  });

  it("keeps `fail` domains misconfigured", async () => {
    const client = createMockDomainsClient();
    await expect(client.addDomain("book.failgarage.co.uk")).resolves.toMatchObject({ verified: true });
    for (let check = 0; check < 3; check += 1) {
      await expect(client.getConfig("book.failgarage.co.uk")).resolves.toMatchObject({ misconfigured: true, configuredBy: null });
    }
  });

  it("simulates taken and rate-limited domains", async () => {
    const client = createMockDomainsClient();
    expect((await caught(client.addDomain("book.takengarage.co.uk"))).code).toBe("domain_taken");
    expect(await caught(client.addDomain("book.ratelimitgarage.co.uk"))).toMatchObject({ code: "rate_limited", retryAfterMs: 60_000 });
    expect(client.list()).toEqual([]);
  });

  it("is idempotent for add and remove, and reports unknown domains as not_found", async () => {
    const client = createMockDomainsClient();
    await client.addDomain(HOST);
    await expect(client.addDomain(HOST)).resolves.toMatchObject({ alreadyExisted: true });
    expect(client.list()).toEqual([HOST]);
    await expect(client.removeDomain(HOST)).resolves.toEqual({ removed: true });
    await expect(client.removeDomain(HOST)).resolves.toEqual({ removed: false });
    expect((await caught(client.getDomain(HOST))).code).toBe("not_found");
    expect((await caught(client.verifyDomain(HOST))).code).toBe("not_found");
    expect((await caught(client.removeDomain("pitline.co.uk"))).code).toBe("invalid_domain");
  });
});

describe("getDomainsClient", () => {
  afterEach(() => {
    (getDomainsClient({}) as MockDomainsClient).reset();
  });

  it("uses a shared mock by default and in mock mode", () => {
    const fallback = getDomainsClient({});
    expect(fallback.mode).toBe("mock");
    expect(getDomainsClient({ VERCEL_DOMAINS_MODE: "mock" })).toBe(fallback);
    expect(getDomainsClient({ VERCEL_ENV: "preview" }).mode).toBe("mock");
  });

  it("uses the real client only in live mode with a token and project", () => {
    const client = getDomainsClient({ VERCEL_DOMAINS_MODE: "live", VERCEL_API_TOKEN: TOKEN, VERCEL_PROJECT_ID: PROJECT, VERCEL_TEAM_ID: TEAM });
    expect(client.mode).toBe("live");
  });

  it.each([
    [{ VERCEL_DOMAINS_MODE: "live" }, /VERCEL_API_TOKEN and VERCEL_PROJECT_ID/],
    [{ VERCEL_DOMAINS_MODE: "live", VERCEL_API_TOKEN: TOKEN }, /VERCEL_PROJECT_ID/],
    [{ VERCEL_DOMAINS_MODE: "sometimes" }, /VERCEL_DOMAINS_MODE/],
    [{ VERCEL_ENV: "production" }, /Production needs VERCEL_DOMAINS_MODE=live/],
  ])("fails closed with configuration_required for %j", (env, message) => {
    let error: unknown;
    try {
      getDomainsClient(env);
    } catch (caughtError) {
      error = caughtError;
    }
    expect(isDomainsError(error) && error.code).toBe("configuration_required");
    expect(String((error as Error).message)).toMatch(message);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("reports readiness by variable name only", () => {
    expect(getDomainsReadiness({})).toEqual({ mode: "mock", status: "mock", missing: [] });
    expect(getDomainsReadiness({ VERCEL_DOMAINS_MODE: "live", VERCEL_API_TOKEN: TOKEN })).toEqual({ mode: "live", status: "configuration_required", missing: ["VERCEL_PROJECT_ID"] });
    const ready = getDomainsReadiness({ VERCEL_DOMAINS_MODE: "LIVE", VERCEL_API_TOKEN: TOKEN, VERCEL_PROJECT_ID: PROJECT });
    expect(ready).toEqual({ mode: "live", status: "operational", missing: [] });
    expect(JSON.stringify(ready)).not.toContain(TOKEN);
    expect(getDomainsReadiness({ VERCEL_ENV: "production" })).toEqual({ mode: "mock", status: "configuration_required", missing: ["VERCEL_DOMAINS_MODE"] });
  });

  it("reads the CNAME target from env with the Vercel default", () => {
    expect(getDomainCnameTarget({})).toBe("cname.vercel-dns-0.com");
    expect(getDomainCnameTarget({ VERCEL_DOMAIN_CNAME_TARGET: " Custom.Vercel-DNS-017.com. " })).toBe("custom.vercel-dns-017.com");
  });
});

// Real Vercel API, read only. Runs only with VERCEL_DOMAINS_LIVE_TEST=1 plus VERCEL_API_TOKEN,
// VERCEL_PROJECT_ID and VERCEL_TEAM_ID in the environment. It never adds or removes a domain.
describe.skipIf(process.env.VERCEL_DOMAINS_LIVE_TEST !== "1")("Vercel domains live smoke test (read only)", () => {
  it("reads the platform domain from the real API", async () => {
    const client = getDomainsClient({ ...process.env, VERCEL_DOMAINS_MODE: "live" });
    expect(client.mode).toBe("live");
    const config = await client.getConfig("pitline.co.uk");
    expect(typeof config.misconfigured).toBe("boolean");
    try {
      const domain = await client.getDomain("pitline.co.uk");
      expect(domain.name).toBe("pitline.co.uk");
    } catch (error) {
      expect(isDomainsError(error) && error.code).toBe("not_found");
    }
  });
});
