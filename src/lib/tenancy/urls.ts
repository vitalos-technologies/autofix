/**
 * Absolute links for emails, calendar files and redirects.
 * Pure (no I/O); `env` is injectable so every shape is unit tested.
 */
import { freeLinkHost, normaliseHost, type HostEnvironment } from "@/lib/tenancy/hosts";

export type UrlEnvironment = HostEnvironment & {
  NODE_ENV?: string;
  NEXT_PUBLIC_SITE_URL?: string;
};

/** What a garage link needs: its slug and, when verified, its custom booking host. */
export type GarageUrlSubject = { slug: string; customDomain?: string | null };

const DEFAULT_ADMIN_HOST = "pitline.co.uk";
const DEFAULT_DEV_ROOT = "localhost:3000";

function isProduction(env: UrlEnvironment) {
  return env.NODE_ENV === "production";
}

/**
 * The garage's booking site origin, without a trailing slash:
 * - development: `http://<slug>.localhost:3000` (or `DEV_TENANT_ROOT_DOMAIN`);
 * - a verified custom domain when one is active: `https://book.theirgarage.co.uk`;
 * - otherwise the free link `https://<slug>.<NEXT_PUBLIC_TENANT_ROOT_DOMAIN>`.
 */
export function garageBaseUrl(garage: GarageUrlSubject, env: UrlEnvironment = process.env): string {
  if (!isProduction(env)) {
    const devRoot = normaliseHost(env.DEV_TENANT_ROOT_DOMAIN) ?? DEFAULT_DEV_ROOT;
    return `http://${garage.slug}.${devRoot}`;
  }
  const custom = normaliseHost(garage.customDomain);
  if (custom && !custom.includes(":")) return `https://${custom}`;
  return `https://${freeLinkHost(garage.slug, env)}`;
}

/** An absolute link on the garage's booking site, e.g. `garageUrl(garage, "/manage")`. */
export function garageUrl(garage: GarageUrlSubject, path: string, env: UrlEnvironment = process.env): string {
  return new URL(path, `${garageBaseUrl(garage, env)}/`).toString();
}

/** The admin origin (`https://pitline.co.uk`, `http://localhost:3000` in development). */
export function adminBaseUrl(env: UrlEnvironment = process.env): string {
  const configured = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the host-based default.
    }
  }
  if (!isProduction(env)) return `http://${DEFAULT_DEV_ROOT}`;
  return `https://${normaliseHost(env.NEXT_PUBLIC_ADMIN_HOST) ?? DEFAULT_ADMIN_HOST}`;
}

/** An absolute link on the admin host, e.g. `adminUrl("/app/bookings")`. */
export function adminUrl(path: string, env: UrlEnvironment = process.env): string {
  return new URL(path, `${adminBaseUrl(env)}/`).toString();
}
