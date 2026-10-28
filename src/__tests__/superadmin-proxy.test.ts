import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenancy/resolve", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tenancy/resolve")>();
  const lookup = {
    bySlug: async (slug: string) => (slug === "hartley-road" ? { id: "11111111-1111-4111-8111-111111111111", slug, status: "active" } : null),
    byHostname: async () => null,
  };
  return {
    ...original,
    resolveHost: (host: string | null, options: Parameters<typeof original.resolveHost>[1] = {}) =>
      original.resolveHost(host, { ...options, lookup, env: { NEXT_PUBLIC_ADMIN_HOST: "autofix.vitalos.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk", DEV_TENANT_ROOT_DOMAIN: "localhost:3000" } }),
  };
});

import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";
import { clearHostCache } from "@/lib/tenancy/resolve";
import { superadminCookies, superadminOrigin } from "@/lib/superadmin/proxy";

const SECRET = "s".repeat(40);
const ORIGIN = "https://autofix-superadmin.example.azurecontainerapps.io";

function request(url: string, headers: Record<string, string> = {}) {
  const parsed = new URL(url);
  return new NextRequest(url, { headers: new Headers({ host: parsed.host, ...headers }) });
}

/** The headers Next.js will send upstream, as the proxy overrode them. */
function forwarded(response: Response) {
  const names = (response.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  return Object.fromEntries(names.map((name) => [name, response.headers.get(`x-middleware-request-${name}`)]));
}

describe("super admin proxy", () => {
  beforeEach(() => {
    clearHostCache();
    vi.stubEnv("SUPERADMIN_ORIGIN", ORIGIN);
    vi.stubEnv("SUPERADMIN_PROXY_SECRET", SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("forwards /superadmin/* on the admin host to the origin, path and query intact", async () => {
    const response = await proxy(request("https://autofix.vitalos.co.uk/superadmin/garages/?q=hart"));
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${ORIGIN}/superadmin/garages/?q=hart`);
    expect((await proxy(request("https://autofix.vitalos.co.uk/superadmin"))).headers.get("x-middleware-rewrite")).toBe(`${ORIGIN}/superadmin`);
  });

  it("adds the secret, the public host and the client IP, and drops spoofed copies", async () => {
    const response = await proxy(request("https://autofix.vitalos.co.uk/superadmin/", {
      "x-autofix-superadmin-proxy": "guess",
      "x-autofix-superadmin-client-ip": "198.51.100.1",
      "x-autofix-superadmin-anything": "x",
      "x-real-ip": "203.0.113.9",
    }));
    const headers = forwarded(response);
    expect(headers["x-autofix-superadmin-proxy"]).toBe(SECRET);
    expect(headers["x-autofix-superadmin-client-ip"]).toBe("203.0.113.9");
    expect(headers["x-autofix-superadmin-host"]).toBe("autofix.vitalos.co.uk");
    expect(headers).not.toHaveProperty("x-autofix-superadmin-anything");
  });

  it("forwards only the super admin's cookies, never Autofix's session", async () => {
    const response = await proxy(request("https://autofix.vitalos.co.uk/superadmin/", {
      cookie: "sb-abc-auth-token=secret; __Secure-afsa_session=s1; afsa_theme=dark; af_trusted_device=t; afsa_session=x",
    }));
    expect(forwarded(response).cookie).toBe("__Secure-afsa_session=s1; afsa_theme=dark; afsa_session=x");
    const none = await proxy(request("https://autofix.vitalos.co.uk/superadmin/", { cookie: "sb-abc-auth-token=secret" }));
    expect(forwarded(none)).not.toHaveProperty("cookie");
  });

  it("leaves the super admin's own security headers alone", async () => {
    const response = await proxy(request("https://autofix.vitalos.co.uk/superadmin/"));
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("is a 404 on garage hosts", async () => {
    const response = await proxy(request("https://hartley-road.autofix.vitalos.co.uk/superadmin/"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("is a 404 when the origin or secret is missing or unsafe", async () => {
    for (const [origin, secret] of [["", SECRET], [ORIGIN, ""], [ORIGIN, "short"], ["http://superadmin.example.com", SECRET], [`${ORIGIN}/x`, SECRET]]) {
      vi.stubEnv("SUPERADMIN_ORIGIN", origin);
      vi.stubEnv("SUPERADMIN_PROXY_SECRET", secret);
      const response = await proxy(request("https://autofix.vitalos.co.uk/superadmin/"));
      expect(response.status).toBe(404);
      expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("does not catch look-alike paths", async () => {
    const response = await proxy(request("https://autofix.vitalos.co.uk/superadminx"));
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("keeps the super admin's trailing slashes and removes them elsewhere, as Next.js would", async () => {
    expect((await proxy(request("https://autofix.vitalos.co.uk/superadmin/login/"))).status).not.toBe(308);
    const app = await proxy(request("https://autofix.vitalos.co.uk/app/bookings/?view=week"));
    expect(app.status).toBe(308);
    expect(app.headers.get("location")).toBe("https://autofix.vitalos.co.uk/app/bookings?view=week");
    const garage = await proxy(request("https://hartley-road.autofix.vitalos.co.uk/service//"));
    expect(garage.headers.get("location")).toBe("https://hartley-road.autofix.vitalos.co.uk/service");
    expect((await proxy(request("https://autofix.vitalos.co.uk/"))).status).not.toBe(308);
  });

  it("runs for the super admin's static files too", () => {
    expect(config.matcher).toContain("/superadmin/:path*");
  });
});

describe("superadminOrigin", () => {
  it("allows plain http only for localhost outside production", () => {
    expect(superadminOrigin({ SUPERADMIN_ORIGIN: "http://localhost:8000", SUPERADMIN_PROXY_SECRET: SECRET, NODE_ENV: "development" })?.host).toBe("localhost:8000");
    expect(superadminOrigin({ SUPERADMIN_ORIGIN: "http://localhost:8000", SUPERADMIN_PROXY_SECRET: SECRET, NODE_ENV: "production" })).toBeNull();
  });
});

describe("superadminCookies", () => {
  it("rejects cookies that only look like the super admin's", () => {
    expect(superadminCookies("xafsa_session=1; afsa_=2; __Host-afsa_session=3")).toBeNull();
  });
});
