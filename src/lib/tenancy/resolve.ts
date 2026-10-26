import { createClient } from "@supabase/supabase-js";
import { classifyHost, type HostEnvironment, type HostKind } from "@/lib/tenancy/hosts";

/** The minimum the router needs to know about a garage. */
export type HostGarage = { id: string; slug: string; status: string };

export type HostResolution =
  | { kind: "admin" }
  | { kind: "garage"; garage: HostGarage; via: Exclude<HostKind["kind"], "admin" | "unknown"> }
  | { kind: "unknown" };

export interface GarageHostLookup {
  bySlug(slug: string): Promise<HostGarage | null>;
  byHostname(hostname: string): Promise<HostGarage | null>;
}

/** Garage statuses whose booking site is served. */
const SERVED_STATUSES = new Set(["active", "onboarding"]);
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 2_000;

const cache = new Map<string, { value: HostGarage | null; expiresAt: number }>();

export function clearHostCache() {
  cache.clear();
}

async function cached(key: string, now: number, load: () => Promise<HostGarage | null>) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await load();
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

let defaultLookup: GarageHostLookup | null | undefined;

/** Service-role lookup against `garages` / `garage_domains`. Null when Supabase is not configured. */
export function getDefaultHostLookup(): GarageHostLookup | null {
  if (defaultLookup !== undefined) return defaultLookup;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return (defaultLookup = null);
  const client = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  defaultLookup = {
    async bySlug(slug) {
      const { data, error } = await client.from("garages").select("id, slug, status").eq("slug", slug).maybeSingle();
      if (error) throw new Error(`garage lookup failed: ${error.code ?? "unknown"}`);
      return data;
    },
    async byHostname(hostname) {
      const { data, error } = await client
        .from("garage_domains")
        .select("garage:garages!inner(id, slug, status)")
        .eq("hostname", hostname)
        .eq("status", "active")
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(`domain lookup failed: ${error.code ?? "unknown"}`);
      const garage = (data as { garage?: HostGarage | HostGarage[] } | null)?.garage;
      return (Array.isArray(garage) ? garage[0] : garage) ?? null;
    },
  };
  return defaultLookup;
}

/**
 * Maps a request host to the admin surface, a garage booking site or nothing.
 * Results (including misses) are cached for 60 seconds per host.
 */
export async function resolveHost(
  rawHost: string | null | undefined,
  options: { devGarageParam?: string | null; lookup?: GarageHostLookup | null; env?: HostEnvironment; now?: number } = {},
): Promise<HostResolution> {
  const host = classifyHost(rawHost, options.env ?? process.env, options.devGarageParam);
  if (host.kind === "admin" || host.kind === "unknown") return host;

  const lookup = options.lookup === undefined ? getDefaultHostLookup() : options.lookup;
  if (!lookup) return { kind: "unknown" };
  const now = options.now ?? Date.now();

  const garage = host.kind === "custom"
    ? await cached(`host:${host.hostname}`, now, () => lookup.byHostname(host.hostname))
    : await cached(`slug:${host.slug}`, now, () => lookup.bySlug(host.slug));

  if (!garage || !SERVED_STATUSES.has(garage.status)) return { kind: "unknown" };
  return { kind: "garage", garage, via: host.kind };
}
