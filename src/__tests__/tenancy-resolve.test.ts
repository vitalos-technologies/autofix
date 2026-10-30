import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearHostCache, resolveHost, type GarageHostLookup, type HostGarage } from "@/lib/tenancy/resolve";

const env = { NEXT_PUBLIC_ADMIN_HOST: "pitline.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "pitline.co.uk", DEV_TENANT_ROOT_DOMAIN: "localhost:3000" };
const hartley: HostGarage = { id: "11111111-1111-4111-8111-111111111111", slug: "hartley-road", status: "active" };
const suspended: HostGarage = { id: "22222222-2222-4222-8222-222222222222", slug: "gone-garage", status: "suspended" };

function lookup(): GarageHostLookup & { bySlug: ReturnType<typeof vi.fn>; byHostname: ReturnType<typeof vi.fn> } {
  return {
    bySlug: vi.fn(async (slug: string) => [hartley, suspended].find((garage) => garage.slug === slug) ?? null),
    byHostname: vi.fn(async (hostname: string) => (hostname === "book.hartleyroad.co.uk" ? hartley : null)),
  };
}

describe("resolveHost", () => {
  beforeEach(() => clearHostCache());

  it("returns admin without a lookup", async () => {
    const source = lookup();
    await expect(resolveHost("pitline.co.uk", { env, lookup: source })).resolves.toEqual({ kind: "admin" });
    expect(source.bySlug).not.toHaveBeenCalled();
  });

  it("resolves free links, dev hosts and custom domains", async () => {
    const source = lookup();
    await expect(resolveHost("hartley-road.pitline.co.uk", { env, lookup: source })).resolves.toEqual({ kind: "garage", garage: hartley, via: "subdomain" });
    await expect(resolveHost("hartley-road.localhost:3000", { env, lookup: source })).resolves.toEqual({ kind: "garage", garage: hartley, via: "dev-garage" });
    await expect(resolveHost("localhost:3000", { env, lookup: source, devGarageParam: "hartley-road" })).resolves.toEqual({ kind: "garage", garage: hartley, via: "dev-garage" });
    await expect(resolveHost("book.hartleyroad.co.uk", { env, lookup: source })).resolves.toEqual({ kind: "garage", garage: hartley, via: "custom" });
  });

  it("returns unknown for unverified domains, missing slugs and suspended garages", async () => {
    const source = lookup();
    await expect(resolveHost("book.unknown.co.uk", { env, lookup: source })).resolves.toEqual({ kind: "unknown" });
    await expect(resolveHost("nobody.pitline.co.uk", { env, lookup: source })).resolves.toEqual({ kind: "unknown" });
    await expect(resolveHost("gone-garage.pitline.co.uk", { env, lookup: source })).resolves.toEqual({ kind: "unknown" });
    await expect(resolveHost("www.pitline.co.uk", { env, lookup: source })).resolves.toEqual({ kind: "unknown" });
  });

  it("returns unknown when Supabase is not configured", async () => {
    await expect(resolveHost("hartley-road.pitline.co.uk", { env, lookup: null })).resolves.toEqual({ kind: "unknown" });
  });

  it("caches hits and misses for 60 seconds", async () => {
    const source = lookup();
    await resolveHost("hartley-road.pitline.co.uk", { env, lookup: source, now: 0 });
    await resolveHost("hartley-road.pitline.co.uk", { env, lookup: source, now: 59_000 });
    await resolveHost("book.unknown.co.uk", { env, lookup: source, now: 0 });
    await resolveHost("book.unknown.co.uk", { env, lookup: source, now: 30_000 });
    expect(source.bySlug).toHaveBeenCalledTimes(1);
    expect(source.byHostname).toHaveBeenCalledTimes(1);
    await resolveHost("hartley-road.pitline.co.uk", { env, lookup: source, now: 60_001 });
    expect(source.bySlug).toHaveBeenCalledTimes(2);
  });
});
