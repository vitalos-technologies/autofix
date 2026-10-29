import { describe, expect, it } from "vitest";
import { classifyHost, freeLinkHost, isValidSlug, normaliseHost, type HostEnvironment } from "@/lib/tenancy/hosts";

const production: HostEnvironment = {
  NEXT_PUBLIC_ADMIN_HOST: "pitline.co.uk",
  NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "pitline.co.uk",
  VERCEL_ENV: "production",
  DEV_TENANT_ROOT_DOMAIN: "localhost:3000",
};

const development: HostEnvironment = {
  NEXT_PUBLIC_ADMIN_HOST: "pitline.co.uk",
  NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "pitline.co.uk",
  DEV_TENANT_ROOT_DOMAIN: "localhost:3000",
};

describe("classifyHost", () => {
  it("serves the admin on the admin host", () => {
    expect(classifyHost("pitline.co.uk", production)).toEqual({ kind: "admin" });
    expect(classifyHost("PITLINE.co.uk:443", production)).toEqual({ kind: "admin" });
    expect(classifyHost("pitline.co.uk.", production)).toEqual({ kind: "admin" });
  });

  it("maps free-link subdomains to a slug", () => {
    expect(classifyHost("hartley-road.pitline.co.uk", production)).toEqual({ kind: "subdomain", slug: "hartley-road" });
  });

  it("rejects reserved, malformed and nested free-link labels", () => {
    expect(classifyHost("www.pitline.co.uk", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("api.pitline.co.uk", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("-bad.pitline.co.uk", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("a.b.pitline.co.uk", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("ab.pitline.co.uk", production)).toEqual({ kind: "unknown" });
  });

  it("treats any other public hostname as a custom garage domain", () => {
    expect(classifyHost("book.theirgarage.co.uk", production)).toEqual({ kind: "custom", hostname: "book.theirgarage.co.uk" });
    expect(classifyHost("Book.TheirGarage.co.uk", production)).toEqual({ kind: "custom", hostname: "book.theirgarage.co.uk" });
  });

  it("returns unknown for empty, IP, port-bearing and junk hosts", () => {
    expect(classifyHost(null, production)).toEqual({ kind: "unknown" });
    expect(classifyHost("", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("203.0.113.10", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("book.theirgarage.co.uk:8080", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("intranet", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("evil.com/path", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("user@evil.com", production)).toEqual({ kind: "unknown" });
  });

  it("ignores dev hosts and the __garage override in production", () => {
    expect(classifyHost("localhost:3000", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("hartley-road.localhost:3000", production)).toEqual({ kind: "unknown" });
    expect(classifyHost("pitline.co.uk", production, "hartley-road")).toEqual({ kind: "admin" });
  });

  it("serves the admin on localhost in development", () => {
    expect(classifyHost("localhost:3000", development)).toEqual({ kind: "admin" });
    expect(classifyHost("127.0.0.1:3100", development)).toEqual({ kind: "admin" });
  });

  it("maps <slug>.localhost and ?__garage= to a dev garage", () => {
    expect(classifyHost("hartley-road.localhost:3000", development)).toEqual({ kind: "dev-garage", slug: "hartley-road" });
    expect(classifyHost("localhost:3000", development, "demo-b")).toEqual({ kind: "dev-garage", slug: "demo-b" });
    expect(classifyHost("localhost:3000", development, "Not A Slug")).toEqual({ kind: "unknown" });
  });

  it("serves the admin on this deployment's Vercel URLs", () => {
    const preview = { ...production, VERCEL_ENV: "preview", VERCEL_URL: "autofix-abc123-vitalos.vercel.app" };
    expect(classifyHost("autofix-abc123-vitalos.vercel.app", preview)).toEqual({ kind: "admin" });
    expect(classifyHost("other-project.vercel.app", preview)).toEqual({ kind: "custom", hostname: "other-project.vercel.app" });
  });

  it("falls back to the platform defaults when env is unset", () => {
    expect(classifyHost("pitline.co.uk", {})).toEqual({ kind: "admin" });
    expect(classifyHost("demo-b.pitline.co.uk", {})).toEqual({ kind: "subdomain", slug: "demo-b" });
  });
});

describe("host helpers", () => {
  it("normalises hosts", () => {
    expect(normaliseHost(" Example.COM:80 ")).toBe("example.com");
    expect(normaliseHost("a b")).toBeNull();
  });

  it("validates slugs", () => {
    expect(isValidSlug("hartley-road")).toBe(true);
    expect(isValidSlug("demo-b")).toBe(true);
    expect(isValidSlug("admin")).toBe(false);
    expect(isValidSlug("double--dash")).toBe(false);
    expect(isValidSlug("x".repeat(41))).toBe(false);
  });

  it("builds the free link host", () => {
    expect(freeLinkHost("hartley-road", production)).toBe("hartley-road.pitline.co.uk");
  });
});
