import { beforeEach, describe, expect, it, vi } from "vitest";

const garages = vi.hoisted(() => ({
  hartley: { id: "11111111-1111-4111-8111-111111111111", slug: "hartley-road", status: "active", embedOrigins: ["https://www.hartleyroad.co.uk"], widgetEnabled: true },
  plain: { id: "22222222-2222-4222-8222-222222222222", slug: "plain-garage", status: "active", embedOrigins: [], widgetEnabled: false },
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
      original.resolveHost(host, { ...options, lookup, env: { NEXT_PUBLIC_ADMIN_HOST: "autofix.vitalos.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk", DEV_TENANT_ROOT_DOMAIN: "localhost:3000" } }),
  };
});

import { NextRequest } from "next/server";
import { embedOriginsFromSettings, MAX_EMBED_ORIGINS, normaliseEmbedOrigin, parseEmbedOrigins } from "@/lib/booking-page/embed-origins";
import { ADMIN_SECURITY_HEADERS, bookingSiteCsp, bookingSiteHeaders } from "@/lib/booking-page/security-headers";
import { clearHostCache } from "@/lib/tenancy/resolve";
import { proxy } from "@/proxy";

function directive(csp: string, name: string) {
  return csp.split("; ").find((part) => part.startsWith(`${name} `)) ?? null;
}

describe("embed origin validation", () => {
  it.each([
    ["https://www.hartleyroad.co.uk", "https://www.hartleyroad.co.uk"],
    ["HTTPS://WWW.HartleyRoad.co.uk/", "https://www.hartleyroad.co.uk"],
    ["www.hartleyroad.co.uk", "https://www.hartleyroad.co.uk"],
    ["https://shop.example.com:8443", "https://shop.example.com:8443"],
    ["  https://xn--bcher-kva.example  ", "https://xn--bcher-kva.example"],
  ])("accepts %s as %s", (input, origin) => {
    expect(normaliseEmbedOrigin(input)).toBe(origin);
  });

  it.each([
    "http://www.hartleyroad.co.uk",
    "https://www.hartleyroad.co.uk/book",
    "https://www.hartleyroad.co.uk/?a=1",
    "https://*.hartleyroad.co.uk",
    "https://user:pass@hartleyroad.co.uk",
    "https://192.168.1.10",
    "https://localhost",
    "javascript:alert(1)",
    "'unsafe-inline'",
    "https://hartley road.co.uk",
    "*",
    "",
  ])("refuses %s", (input) => {
    expect(normaliseEmbedOrigin(input)).toBeNull();
  });

  it("parses one per line or comma separated, de-duplicated", () => {
    expect(parseEmbedOrigins("https://a.example\nb.example, https://a.example/\n\n")).toEqual({ ok: true, origins: ["https://a.example", "https://b.example"] });
    expect(parseEmbedOrigins("")).toEqual({ ok: true, origins: [] });
  });

  it("names the bad entry and caps the list", () => {
    const bad = parseEmbedOrigins("https://a.example\nhttp://b.example");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).toContain("http://b.example");
    const many = Array.from({ length: MAX_EMBED_ORIGINS + 1 }, (_, index) => `https://s${index}.example`).join("\n");
    expect(parseEmbedOrigins(many)).toEqual({ ok: false, message: `You can allow up to ${MAX_EMBED_ORIGINS} websites.` });
  });

  it("re-validates stored settings and drops anything malformed", () => {
    expect(embedOriginsFromSettings({ embedOrigins: ["https://a.example", "http://evil.example", 42, "https://a.example", "https://x.example; script-src *"] })).toEqual(["https://a.example"]);
    expect(embedOriginsFromSettings({ embedOrigins: "https://a.example" })).toEqual([]);
    expect(embedOriginsFromSettings(null)).toEqual([]);
  });
});

describe("CSP per garage", () => {
  it("lets only the garage's sites frame its booking pages", () => {
    const csp = bookingSiteCsp({ embedOrigins: ["https://www.hartleyroad.co.uk", "https://shop.example.com:8443"] });
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'self' https://www.hartleyroad.co.uk https://shop.example.com:8443");
    expect(directive(bookingSiteCsp({}), "frame-ancestors")).toBe("frame-ancestors 'self'");
  });

  it("allows the Askbridge origin only when the widget is on", () => {
    const on = bookingSiteCsp({ widgetOrigin: "https://widget.askbridge.example" });
    for (const name of ["script-src", "connect-src", "frame-src"]) expect(directive(on, name)).toContain("https://widget.askbridge.example");
    const off = bookingSiteCsp({ widgetOrigin: null });
    expect(off).not.toContain("askbridge");
  });

  it("keeps Turnstile working and locks down the rest", () => {
    const csp = bookingSiteCsp({});
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    expect(directive(csp, "frame-src")).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(bookingSiteCsp({ dev: true })).toContain("'unsafe-eval'");
  });

  it("never sends X-Frame-Options on the booking host; the admin host stays same-origin", () => {
    expect(bookingSiteHeaders({})).not.toHaveProperty("X-Frame-Options");
    expect(ADMIN_SECURITY_HEADERS).toEqual({ "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" });
  });
});

describe("proxy security headers", () => {
  const request = (url: string) => new NextRequest(url, { headers: new Headers({ host: new URL(url).host }) });

  beforeEach(() => {
    clearHostCache();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL = "https://widget.askbridge.example/v1/widget.js";
  });

  it("sends the garage's frame-ancestors and widget origin on its booking host", async () => {
    const response = await proxy(request("https://book.hartleyroad.co.uk/"));
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'self' https://www.hartleyroad.co.uk");
    expect(directive(csp, "script-src")).toContain("https://widget.askbridge.example");
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("does not allow other sites or the widget for a garage that has neither", async () => {
    const response = await proxy(request("https://plain-garage.autofix.vitalos.co.uk/time"));
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'self'");
    expect(csp).not.toContain("askbridge");
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("keeps the admin host and unknown hosts same-origin only", async () => {
    for (const url of ["https://autofix.vitalos.co.uk/app/settings/booking-page", "https://nobody.autofix.vitalos.co.uk/"]) {
      const response = await proxy(request(url));
      expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    }
  });
});

describe("host cache", () => {
  it("is shared through globalThis and can be cleared per host", async () => {
    const { resolveHost: realResolveHost } = await vi.importActual<typeof import("@/lib/tenancy/resolve")>("@/lib/tenancy/resolve");
    let calls = 0;
    const lookup = {
      bySlug: async () => null,
      byHostname: async () => {
        calls += 1;
        return { id: garages.hartley.id, slug: "hartley-road", status: "active" };
      },
    };
    const env = { NEXT_PUBLIC_ADMIN_HOST: "autofix.vitalos.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk" };
    clearHostCache();
    await realResolveHost("book.cache-test.co.uk", { lookup, env, now: 0 });
    await realResolveHost("book.cache-test.co.uk", { lookup, env, now: 1 });
    expect(calls).toBe(1);
    clearHostCache({ hostnames: ["BOOK.cache-test.co.uk"] });
    await realResolveHost("book.cache-test.co.uk", { lookup, env, now: 2 });
    expect(calls).toBe(2);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("autofix.tenancy.hostCache")]).toBeInstanceOf(Map);
  });
});
