import { beforeEach, describe, expect, it, vi } from "vitest";

const garages = vi.hoisted(() => ({
  hartley: { id: "11111111-1111-4111-8111-111111111111", slug: "hartley-road", status: "active" },
  demoB: { id: "22222222-2222-4222-8222-222222222222", slug: "demo-b", status: "active" },
}));

vi.mock("@/lib/tenancy/resolve", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tenancy/resolve")>();
  const lookup = {
    bySlug: async (slug: string) => Object.values(garages).find((garage) => garage.slug === slug) ?? null,
    byHostname: async (hostname: string) => (hostname === "book.hartleyroad.co.uk" ? garages.hartley : null),
  };
  return {
    ...original,
    resolveHost: (host: string | null, options: Parameters<typeof original.resolveHost>[1] = {}) =>
      original.resolveHost(host, { ...options, lookup, env: { NEXT_PUBLIC_ADMIN_HOST: "pitline.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "pitline.co.uk", DEV_TENANT_ROOT_DOMAIN: "localhost:3000" } }),
  };
});

import { NextRequest } from "next/server";
import { clearHostCache } from "@/lib/tenancy/resolve";
import { DEV_GARAGE_COOKIE, proxy } from "@/proxy";

function request(url: string, init: { host?: string; cookie?: string } = {}) {
  const parsed = new URL(url);
  const headers = new Headers({ host: init.host ?? parsed.host });
  if (init.cookie) headers.set("cookie", init.cookie);
  return new NextRequest(url, { headers });
}

const rewriteOf = (response: Response) => response.headers.get("x-middleware-rewrite");

describe("host routing proxy", () => {
  beforeEach(() => {
    clearHostCache();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  });

  it("rewrites a free link to the garage's internal site", async () => {
    const response = await proxy(request("https://hartley-road.pitline.co.uk/service?x=1"));
    expect(rewriteOf(response)).toBe(`https://hartley-road.pitline.co.uk/_site/${garages.hartley.id}/service?x=1`);
  });

  it("rewrites the root of a verified custom domain", async () => {
    const response = await proxy(request("https://book.hartleyroad.co.uk/"));
    expect(rewriteOf(response)).toBe(`https://book.hartleyroad.co.uk/_site/${garages.hartley.id}`);
  });

  it("passes public API calls through on garage hosts", async () => {
    const response = await proxy(request("https://hartley-road.pitline.co.uk/api/slots"));
    expect(rewriteOf(response)).toBeNull();
    expect(response.status).toBe(200);
  });

  it.each(["/app", "/app/bookings", "/admin", "/auth/confirm", "/api/admin/notifications/count", "/api/cron/retention", "/api/agent/v1/list_services", "/dev/components", `/_site/${garages.demoB.id}`])(
    "returns 404 for %s on a garage host",
    async (path) => {
      const response = await proxy(request(`https://hartley-road.pitline.co.uk${path}`));
      expect(response.status).toBe(404);
      expect(rewriteOf(response)).toBeNull();
    },
  );

  it("returns 404 for unknown hosts, unverified domains and missing garages", async () => {
    for (const url of ["https://book.unknown.co.uk/", "https://nobody.pitline.co.uk/", "https://www.pitline.co.uk/"]) {
      const response = await proxy(request(url));
      expect(response.status).toBe(404);
    }
  });

  it("serves the admin host without rewriting and hides /_site there", async () => {
    expect(rewriteOf(await proxy(request("https://pitline.co.uk/app")))).toBeNull();
    expect((await proxy(request("https://pitline.co.uk/app"))).status).toBe(200);
    expect((await proxy(request(`https://pitline.co.uk/_site/${garages.hartley.id}`))).status).toBe(404);
  });

  it("maps <slug>.localhost to the garage in development", async () => {
    const response = await proxy(request("http://demo-b.localhost:3000/time"));
    expect(rewriteOf(response)).toBe(`http://demo-b.localhost:3000/_site/${garages.demoB.id}/time`);
  });

  it("remembers ?__garage= on localhost but never hides the admin", async () => {
    const first = await proxy(request("http://localhost:3000/?__garage=hartley-road"));
    expect(rewriteOf(first)).toBe(`http://localhost:3000/_site/${garages.hartley.id}`);
    expect(first.headers.get("set-cookie")).toContain(`${DEV_GARAGE_COOKIE}=hartley-road`);

    const cookie = `${DEV_GARAGE_COOKIE}=hartley-road`;
    expect(rewriteOf(await proxy(request("http://localhost:3000/details", { cookie })))).toBe(`http://localhost:3000/_site/${garages.hartley.id}/details`);
    const admin = await proxy(request("http://localhost:3000/app", { cookie }));
    expect(admin.status).toBe(200);
    expect(rewriteOf(admin)).toBeNull();

    const cleared = await proxy(request("http://localhost:3000/?__garage=", { cookie }));
    expect(cleared.headers.get("set-cookie")).toContain(`${DEV_GARAGE_COOKIE}=;`);
  });

  it("ignores ?__garage= on the production admin host", async () => {
    const response = await proxy(request("https://pitline.co.uk/?__garage=hartley-road"));
    expect(rewriteOf(response)).toBeNull();
  });

  it("forwards the request method and path to admin-host server code, overwriting any client value (P4.5)", async () => {
    const forged = new NextRequest("https://pitline.co.uk/app/customers?q=AB12CDE", {
      method: "POST",
      headers: { host: "pitline.co.uk", "x-autofix-method": "GET", "x-autofix-path": "/elsewhere" },
    });
    const response = await proxy(forged);
    expect(response.headers.get("x-middleware-request-x-autofix-method")).toBe("POST");
    expect(response.headers.get("x-middleware-request-x-autofix-path")).toBe("/app/customers");
    const admin = await proxy(request("https://pitline.co.uk/admin"));
    expect(admin.status).toBe(200);
    expect(admin.headers.get("x-middleware-request-x-autofix-method")).toBe("GET");
  });

  describe("old Autofix addresses (DECISIONS D22)", () => {
    it("redirects the old admin host permanently, keeping the path and query", async () => {
      const response = await proxy(request("https://autofix.vitalos.co.uk/app/bookings?day=2026-10-30&view=bay"));
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("https://pitline.co.uk/app/bookings?day=2026-10-30&view=bay");
    });

    it("redirects the super admin and slashed paths as they are (the new host tidies the slash)", async () => {
      const superadmin = await proxy(request("https://autofix.vitalos.co.uk/superadmin/login/?next=%2Fsuperadmin%2F"));
      expect(superadmin.status).toBe(308);
      expect(superadmin.headers.get("location")).toBe("https://pitline.co.uk/superadmin/login/?next=%2Fsuperadmin%2F");
      const slashed = await proxy(request("https://autofix.vitalos.co.uk/pricing/"));
      expect(slashed.headers.get("location")).toBe("https://pitline.co.uk/pricing/");
    });

    it("redirects an old free link to the garage's new one", async () => {
      const response = await proxy(request("https://hartley-road.autofix.vitalos.co.uk/manage?ref=HR-1234"));
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("https://hartley-road.pitline.co.uk/manage?ref=HR-1234");
    });

    it.each(["/api/webhooks/twilio/sms", "/api/webhooks/billing/stripe", "/api/webhooks/resend", "/api/cron/daily"])(
      "serves %s on the old host instead of redirecting (providers still post there)",
      async (path) => {
        const response = await proxy(request(`https://autofix.vitalos.co.uk${path}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();
        expect(rewriteOf(response)).toBeNull();
      },
    );

    it("does not redirect lookalike or nested hosts", async () => {
      for (const url of ["https://autofix.vitalos.co.uk.evil.example/", "https://a.b.autofix.vitalos.co.uk/", "https://www.autofix.vitalos.co.uk/"]) {
        const response = await proxy(request(url));
        expect(response.status).toBe(404);
        expect(response.headers.get("location")).toBeNull();
      }
    });
  });
});
