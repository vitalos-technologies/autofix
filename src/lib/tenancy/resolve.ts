import { createClient } from "@supabase/supabase-js";
import { askbridgeFromSettings } from "@/lib/askbridge/config";
import { embedOriginsFromSettings } from "@/lib/booking-page/embed-origins";
import { classifyHost, type HostEnvironment, type HostKind } from "@/lib/tenancy/hosts";

/**
 * The minimum the router needs to know about a garage. `embedOrigins` and `widgetEnabled` (from
 * `garages.settings`) shape the booking host's Content-Security-Policy in the proxy.
 */
export type HostGarage = { id: string; slug: string; status: string; embedOrigins?: string[]; widgetEnabled?: boolean };

type GarageRow = { id: string; slug: string; status: string; settings?: unknown };

function hostGarage(row: GarageRow | null | undefined): HostGarage | null {
  if (!row) return null;
  return { id: row.id, slug: row.slug, status: row.status, embedOrigins: embedOriginsFromSettings(row.settings), widgetEnabled: askbridgeFromSettings(row.settings).enabled };
}

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

// One cache per server process, shared by the proxy bundle and the app bundle (each has its own copy
// of this module), so a settings change can clear what the proxy serves from.
const CACHE_KEY = Symbol.for("autofix.tenancy.hostCache");
const cache: Map<string, { value: HostGarage | null; expiresAt: number }> = ((globalThis as Record<symbol, unknown>)[CACHE_KEY] ??= new Map()) as Map<
  string,
  { value: HostGarage | null; expiresAt: number }
>;

/**
 * Forget cached host lookups (all, or the given hosts/slugs) after a domain or embed setting changes.
 * Other server instances catch up within the 60 s TTL.
 */
export function clearHostCache(keys?: { hostnames?: string[]; slugs?: string[] }) {
  if (!keys) {
    cache.clear();
    return;
  }
  for (const hostname of keys.hostnames ?? []) cache.delete(`host:${hostname.toLowerCase()}`);
  for (const slug of keys.slugs ?? []) cache.delete(`slug:${slug}`);
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
      const { data, error } = await client.from("garages").select("id, slug, status, settings").eq("slug", slug).maybeSingle();
      if (error) throw new Error(`garage lookup failed: ${error.code ?? "unknown"}`);
      return hostGarage(data);
    },
    async byHostname(hostname) {
      const { data, error } = await client
        .from("garage_domains")
        .select("garage:garages!inner(id, slug, status, settings)")
        .eq("hostname", hostname)
        .eq("status", "active")
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(`domain lookup failed: ${error.code ?? "unknown"}`);
      const garage = (data as { garage?: GarageRow | GarageRow[] } | null)?.garage;
      return hostGarage(Array.isArray(garage) ? garage[0] : garage);
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
